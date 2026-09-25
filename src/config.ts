import "dotenv/config";
import { ConfigSchema } from "./config-schema.js";
import { registerSecrets } from "./secrets.js";
const result = ConfigSchema.safeParse(process.env);
if (!result.success) throw new Error(`Invalid bridge configuration: ${result.error.issues.map(issue => issue.path.join(".")).join(", ")}. See .env.example.`);
export const config = result.data;
registerSecrets(config.LINEAR_CLIENT_SECRET, config.LINEAR_WEBHOOK_SECRET, config.GITHUB_WEBHOOK_SECRET, config.INSTALL_SECRET, config.T3CODE_TOKEN);
export function publicConfig() {
  return { baseUrl: config.BASE_URL, redirectUri: config.LINEAR_REDIRECT_URI, host: config.HOST, port: config.PORT,
    installSecretConfigured: Boolean(config.INSTALL_SECRET),
    maxConcurrentSessions: config.MAX_CONCURRENT_SESSIONS, pollIntervalMs: config.POLL_INTERVAL_MS,
    progressDebounceMs: config.PROGRESS_DEBOUNCE_MS, progressHeartbeatMs: config.PROGRESS_HEARTBEAT_MS };
}
