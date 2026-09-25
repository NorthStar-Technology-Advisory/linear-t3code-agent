import { registerSecrets } from "./secrets.js";
import { config } from "./config.js";
import { readJsonFile, writePrivateJsonFile, type TokenRecord } from "./storage.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

type StoredInstallation = TokenRecord & {
  installed_at: number;
  updated_at: number;
};

type TokenStore = {
  default_app_user_id?: string;
  installations: Record<string, StoredInstallation>;
};

type LinearTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string | string[];
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; path?: Array<string | number>; extensions?: { code?: string } }>;
};

export class LinearRateLimitError extends Error {
  constructor() { super("Linear API rate limit reached; retrying after cooldown."); }
}

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

function now() {
  return Date.now();
}

function tokenStoreFallback(): TokenStore {
  return { installations: {} };
}

async function readTokenStore(tokenPath = config.TOKEN_STORE_PATH): Promise<TokenStore> {
  return readJsonFile<TokenStore>(tokenPath, tokenStoreFallback());
}

async function selectInstallation(tokenPath?: string): Promise<{ store: TokenStore; appUserId: string; installation: StoredInstallation }> {
  const store = await readTokenStore(tokenPath);
  const appUserId = store.default_app_user_id ?? Object.keys(store.installations)[0];

  if (!appUserId) {
    throw new Error("Linear is not installed yet. Visit /linear/install first.");
  }

  const installation = store.installations[appUserId];
  if (!installation) {
    throw new Error("Linear token store is missing the default installation.");
  }

  return { store, appUserId, installation };
}

async function refreshInstallation(
  store: TokenStore,
  appUserId: string,
  installation: StoredInstallation,
  tokenPath = config.TOKEN_STORE_PATH,
): Promise<StoredInstallation> {
  if (!installation.refresh_token) {
    throw new Error("Linear access token expired and no refresh token is stored.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: installation.refresh_token,
    client_id: config.LINEAR_CLIENT_ID,
    client_secret: config.LINEAR_CLIENT_SECRET,
  });

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = (await response.json()) as Partial<LinearTokenResponse> & { error_description?: string };

  if (!response.ok || !json.access_token || !json.expires_in) {
    throw new Error(`Linear token refresh failed (HTTP ${response.status}); reinstall or repair the stored credentials.`);
  }

  const refreshed: StoredInstallation = {
    ...installation,
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? installation.refresh_token,
    token_type: json.token_type,
    expires_at: now() + json.expires_in * 1000,
    scope: json.scope,
    updated_at: now(),
  };

  store.installations[appUserId] = refreshed;
  store.default_app_user_id = appUserId;
  await writePrivateJsonFile(tokenPath, store);
  return refreshed;
}

async function loadAccessToken(tokenPath: string): Promise<string> {
  const { store, appUserId, installation } = await selectInstallation(tokenPath);

  registerSecrets(installation.access_token, installation.refresh_token);
  if (installation.expires_at - REFRESH_SKEW_MS > now()) {
    return installation.access_token;
  }

  const refreshed = await refreshInstallation(store, appUserId, installation, tokenPath);
  registerSecrets(refreshed.access_token, refreshed.refresh_token);
  return refreshed.access_token;
}

const tokenRequests = new Map<string, Promise<string>>();
export function getAccessToken(tokenPath = config.TOKEN_STORE_PATH): Promise<string> {
  const existing = tokenRequests.get(tokenPath);
  if (existing) return existing;
  const pending = loadAccessToken(tokenPath).finally(() => { tokenRequests.delete(tokenPath); });
  tokenRequests.set(tokenPath, pending);
  return pending;
}

export async function linearGraphql<T>(query: string, variables?: Record<string, unknown>, options?: { endpoint?: string; tokenPath?: string }): Promise<T> {
  const accessToken = await getAccessToken(options?.tokenPath);

  const response = await fetch(options?.endpoint ?? LINEAR_GRAPHQL_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as GraphqlResponse<T>;

  if (json.errors?.some(error => error.extensions?.code === "RATELIMITED")) throw new LinearRateLimitError();
  if (!response.ok || json.errors?.length) {
    throw new Error(`Linear GraphQL failed (HTTP ${response.status}); check credentials, scopes, access and the current schema.`);
  }

  if (!json.data) {
    throw new Error("Linear GraphQL response did not include data.");
  }

  return json.data;
}

export async function getLinearViewer(): Promise<{ id: string; name?: string }> {
  const data = await linearGraphql<{ viewer: { id: string; name?: string } }>(
    "query Viewer { viewer { id name } }",
  );
  return data.viewer;
}

export async function createAgentActivity(
  agentSessionId: string,
  content: AgentActivityContent,
  options?: { ephemeral?: boolean; id?: string; endpoint?: string; tokenPath?: string },
): Promise<{ id: string }> {
  const data = await linearGraphql<{ agentActivityCreate: { success: boolean; agentActivity: { id: string } } }>(
    `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
        agentActivity { id }
      }
    }`,
    {
      input: {
        id: options?.id,
        agentSessionId,
        content,
        ephemeral: options?.ephemeral,
      },
    },
    options,
  );

  if (!data.agentActivityCreate.success) {
    throw new Error("Linear agentActivityCreate returned success=false");
  }

  return { id: data.agentActivityCreate.agentActivity.id };
}
