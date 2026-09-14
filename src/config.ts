import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { registerSecrets } from "./secrets.js";
import type { Route } from "./repository.js";
const emptyStringAsUndefined = (value: unknown) => value === "" ? undefined : value;
const absolutePath = z.string().min(1).refine(path.isAbsolute, "must be an absolute path");
const serviceUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "must be an HTTP(S) URL without credentials, query or fragment");
const ConfigSchema = z.object({
  LINEAR_CLIENT_ID: z.string().min(1), LINEAR_CLIENT_SECRET: z.string().min(1), LINEAR_WEBHOOK_SECRET: z.string().min(1),
  INSTALL_SECRET: z.preprocess(emptyStringAsUndefined, z.string().min(16).optional()),
  LINEAR_REDIRECT_URI: z.string().url(), BASE_URL: serviceUrl,
  T3CODE_URL: serviceUrl, T3CODE_TOKEN: z.string().min(1),
  T3CODE_PROVIDER: z.string().min(1), T3CODE_MODEL: z.string().min(1),
  PROJECT_ROUTES: z.string().default("{}"),
  BRIDGE_DB_PATH: z.string().default("./data/bridge.sqlite"),
  WORKTREE_ROOT: z.string().default("./data/worktrees"),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(1),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  PR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  PROGRESS_DEBOUNCE_MS: z.coerce.number().int().positive().default(3000),
  PROGRESS_HEARTBEAT_MS: z.coerce.number().int().positive().default(300_000),
  HOST: z.string().default("127.0.0.1"), PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  TOKEN_STORE_PATH: z.string().default("./data/linear-tokens.json"), STATE_STORE_PATH: z.string().default("./data/oauth-states.json"),
});
const result = ConfigSchema.safeParse(process.env);
if (!result.success) throw new Error(`Invalid bridge configuration: ${result.error.issues.map(issue => issue.path.join(".")).join(", ")}. See .env.example.`);
export const config = result.data;
registerSecrets(config.LINEAR_CLIENT_SECRET, config.LINEAR_WEBHOOK_SECRET, config.INSTALL_SECRET, config.T3CODE_TOKEN);
const RouteSchema = z.record(z.object({
  repository: absolutePath, t3ProjectId: z.string().min(1),
  provider: z.string().min(1).default(config.T3CODE_PROVIDER), model: z.string().min(1).default(config.T3CODE_MODEL),
  baseBranch: z.string().regex(/^(?!-)[a-zA-Z0-9_./-]+$/).default("main"),
}).strict());
function parseRoutes(): Record<string, Route> {
  try { return RouteSchema.parse(JSON.parse(config.PROJECT_ROUTES)); }
  catch { throw new Error("Invalid PROJECT_ROUTES. Use a JSON object mapping Linear project IDs to absolute repository paths and T3Code project IDs; see .env.example."); }
}
export const projectRoutes = parseRoutes();
export function publicConfig() {
  return { baseUrl: config.BASE_URL, redirectUri: config.LINEAR_REDIRECT_URI, host: config.HOST, port: config.PORT,
    installSecretConfigured: Boolean(config.INSTALL_SECRET), mappedProjectCount: Object.keys(projectRoutes).length,
    maxConcurrentSessions: config.MAX_CONCURRENT_SESSIONS, pollIntervalMs: config.POLL_INTERVAL_MS,
    progressDebounceMs: config.PROGRESS_DEBOUNCE_MS, progressHeartbeatMs: config.PROGRESS_HEARTBEAT_MS };
}
