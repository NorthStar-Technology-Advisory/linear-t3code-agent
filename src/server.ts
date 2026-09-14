import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { config, publicConfig, projectRoutes } from "./config.js";
import { completeOAuthInstall, consumeOAuthState, createInstallUrl } from "./oauth.js";
import { Bridge } from "./bridge.js";
import { LinearClient } from "./linear-context.js";
import { T3CodeRunner } from "./t3code-runner.js";
import { GitHubPullRequests } from "./pull-requests.js";
import { redact } from "./progress.js";
import { isFreshWebhookTimestamp, verifyLinearSignature } from "./signature.js";

type LinearWebhookPayload = {
  type?: string;
  action?: string;
  webhookTimestamp?: number;
  agentSession?: {
    id?: string;
    issue?: {
      identifier?: string;
      title?: string;
      url?: string;
    };
  };
};

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function installSecretFromRequest(req: Request): string | undefined {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return typeof req.query.install_secret === "string" ? req.query.install_secret : undefined;
}

function isInstallAuthorized(req: Request): boolean {
  if (!config.INSTALL_SECRET) return true;
  const provided = installSecretFromRequest(req);
  if (!provided) return false;

  const expected = Buffer.from(config.INSTALL_SECRET);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createApp(bridge?: Bridge) {
  const app = express();

  app.disable("x-powered-by");

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "linear-t3code-agent" });
  });

  app.get("/linear/install", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!isInstallAuthorized(req)) {
        return res.status(401).type("text/plain").send("Missing or invalid install secret.\n");
      }

      const installUrl = await createInstallUrl();
      res.redirect(302, installUrl);
    } catch (error) {
      next(error);
    }
  });

  app.get("/linear/oauth/callback", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (typeof req.query.error === "string") {
        return res.status(400).send(`Linear OAuth error: ${req.query.error}\n`);
      }

      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;

      if (!code || !state) {
        return res.status(400).send("Missing OAuth code or state.\n");
      }

      if (!(await consumeOAuthState(state))) {
        return res.status(401).send("Invalid or expired OAuth state.\n");
      }

      const install = await completeOAuthInstall(code);
      console.log("linear app installed", {
        viewerAppUserId: install.viewerAppUserId,
        scope: install.scope,
      });

      return res.type("text/plain").send(
        [
          "T3Code bridge is installed in Linear.",
          `App user ID: ${install.viewerAppUserId}`,
          "You can close this tab.",
          "",
        ].join("\n"),
      );
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/linear/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: Request, res: Response) => {
      const body = rawBody(req);

      if (!verifyLinearSignature(req.get("linear-signature"), body)) {
        return res.status(401).json({ ok: false, error: "invalid_signature" });
      }

      let payload: LinearWebhookPayload;
      try {
        payload = parseJsonBody(body) as LinearWebhookPayload;
      } catch {
        return res.status(400).json({ ok: false, error: "invalid_json" });
      }

      if (!isFreshWebhookTimestamp(payload?.webhookTimestamp)) {
        return res.status(401).json({ ok: false, error: "stale_webhook" });
      }

      if (!payload || typeof payload !== "object") return res.status(400).json({ ok: false, error: "invalid_payload" });
      if (payload.type === "AgentSessionEvent") {
        if (!bridge) return res.status(503).json({ ok: false, error: "bridge_unavailable" });
        try { bridge.accept(payload); }
        catch (error) {
          if (error instanceof Error && (error.name === "ZodError" || /requires|match/.test(error.message))) return res.status(400).json({ ok: false, error: "invalid_payload" });
          return res.status(503).json({ ok: false, error: "intake_failed" });
        }
      }

      return res.status(200).json({ ok: true, accepted: payload.type === "AgentSessionEvent" });
    },
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "not_found" });
  });

  app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("request failed", { name: error.name, message: redact(error.message) });
    res.status(500).json({ ok: false, error: "internal_error" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  process.umask(0o077);
  const bridge = new Bridge({
    databasePath: config.BRIDGE_DB_PATH, worktreeRoot: config.WORKTREE_ROOT, routes: projectRoutes,
    concurrency: config.MAX_CONCURRENT_SESSIONS, runner: new T3CodeRunner(config.T3CODE_URL, config.T3CODE_TOKEN),
    linear: new LinearClient(), pullRequests: new GitHubPullRequests(), pollMs: config.POLL_INTERVAL_MS,
    prPollMs: config.PR_POLL_INTERVAL_MS, heartbeatMs: config.PROGRESS_HEARTBEAT_MS, progressDebounceMs: config.PROGRESS_DEBOUNCE_MS,
  });
  const app = createApp(bridge);
  const server = app.listen(config.PORT, config.HOST, () => {
    bridge.start();
    console.log("linear t3code bridge listening", publicConfig());
  });
  const shutdown = () => { server.close(); void bridge.close().then(() => process.exit(0)); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
