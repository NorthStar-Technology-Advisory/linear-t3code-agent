import { z } from "zod";
const emptyStringAsUndefined = (value: unknown) => value === "" ? undefined : value;
const serviceUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "must be an HTTP(S) URL without credentials, query or fragment");
export const ConfigSchema = z.object({
  LINEAR_CLIENT_ID: z.string().min(1), LINEAR_CLIENT_SECRET: z.string().min(1), LINEAR_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.preprocess(emptyStringAsUndefined, z.string().min(16).optional()),
  INSTALL_SECRET: z.preprocess(emptyStringAsUndefined, z.string().min(16).optional()),
  LINEAR_REDIRECT_URI: z.string().url(), BASE_URL: serviceUrl,
  T3CODE_URL: serviceUrl, T3CODE_TOKEN: z.string().min(1),
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

export function setupUrl(value: string | undefined, publicUrl = false): boolean {
  try {
    const url = new URL(value || "");
    const host = url.hostname.toLowerCase();
    if (publicUrl && (host === "linear.app" || host.endsWith(".linear.app") || host === "localhost" || host.endsWith(".localhost") || !host.includes(".") || host.includes(":") || /^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host))) return false;
    return (publicUrl ? url.protocol === "https:" : ["http:", "https:"].includes(url.protocol)) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}
