import express from "express";
import { createHash } from "node:crypto";
import type { Config, Policy } from "./config.js";
import { classify } from "./filter.js";
import { isFresh, sign, verifySignature } from "./signature.js";
import { Receipts } from "./receipts.js";

export type Audit = (result: { outcome: string; reason?: string }) => void;
export const createApp = (config: Config, policy: Policy, receipts: Receipts, audit: Audit = () => {}) => {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_req, res) => res.json({ ok: true, service: "linear-t3code-filter-forwarder" }));
  app.post("/linear/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) return res.status(415).json({ ok: false, error: "application_json_required" });
    if (!verifySignature(config.LINEAR_WEBHOOK_SECRET, body, req.get("linear-signature"))) {
      audit({ outcome: "rejected", reason: "invalid_signature" });
      return res.status(401).json({ ok: false, error: "invalid_signature" });
    }
    let decision;
    try {
      const event: unknown = JSON.parse(body.toString("utf8"));
      if (!event || typeof event !== "object" || !isFresh((event as Record<string, unknown>).webhookTimestamp, Date.now(), config.MAX_DELIVERY_AGE_MS)) {
        return res.status(401).json({ ok: false, error: "stale_webhook" });
      }
      decision = classify(event, policy);
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_payload" });
    }
    if (!decision.forward) {
      audit({ outcome: "filtered", reason: decision.reason });
      return res.json({ ok: true, forwarded: false, reason: decision.reason });
    }
    const digest = createHash("sha256").update(body).digest("hex");
    try {
      const claim = receipts.claim(digest, Date.now());
      if (claim === "delivered") return res.json({ ok: true, forwarded: false, reason: "duplicate" });
      if (claim === "busy") return res.status(503).json({ ok: false, error: "delivery_in_progress" });
    } catch {
      return res.status(503).json({ ok: false, error: "receipt_store_unavailable" });
    }
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "linear-signature": sign(config.T3_WEBHOOK_SECRET ?? config.LINEAR_WEBHOOK_SECRET, body),
      };
      for (const name of ["linear-delivery", "linear-event", "linear-timestamp"]) {
        const value = req.get(name); if (value) headers[name] = value;
      }
      const response = await fetch(config.T3_WEBHOOK_URL, {
        method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(config.FORWARD_TIMEOUT_MS),
      });
      // Never log the destination URL, payload, signature, credentials or downstream error body.
      await response.body?.cancel();
      if (!response.ok) throw new Error("upstream_rejected");
      receipts.delivered(digest, Date.now());
      audit({ outcome: "forwarded", reason: decision.reason });
      return res.json({ ok: true, forwarded: true, reason: decision.reason });
    } catch {
      try { receipts.release(digest); } catch { /* A failed receipt remains leased briefly; a retry can recover. */ }
      audit({ outcome: "failed", reason: "upstream_unavailable" });
      return res.status(503).json({ ok: false, error: "upstream_unavailable" });
    }
  });
  app.use((_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const tooLarge = !!error && typeof error === "object" && "type" in error && error.type === "entity.too.large";
    res.status(tooLarge ? 413 : 500).json({ ok: false, error: tooLarge ? "payload_too_large" : "internal_error" });
  });
  return app;
};
