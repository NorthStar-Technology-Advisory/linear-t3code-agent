import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { classify } from "../src/filter.js";
import { ConfigSchema, PolicySchema, type Config, type Policy } from "../src/config.js";
import { Receipts } from "../src/receipts.js";
import { sign } from "../src/signature.js";

const org = "10000000-0000-4000-8000-000000000001";
const project = "10000000-0000-4000-8000-000000000002";
const todo = "10000000-0000-4000-8000-000000000003";
const active = "10000000-0000-4000-8000-000000000004";
const backlog = "10000000-0000-4000-8000-000000000005";
const canceled = "10000000-0000-4000-8000-000000000006";
const secret = "linear-test-signing-secret";
const destinationSecret = "destination-test-signing-secret";
const policy: Policy = { organizationId: org, projectIds: [project], actionableStateIds: [todo], trackedStateIds: [todo, active] };
const event = (overrides: Record<string, unknown> = {}) => ({ type: "Issue", action: "update", organizationId: org,
  webhookTimestamp: Date.now(), data: { id: "issue", projectId: project, stateId: todo }, updatedFrom: { stateId: backlog }, ...overrides });
const urlOf = (server: Server): string => { const a = server.address(); assert.ok(a && typeof a !== "string"); return `http://127.0.0.1:${a.port}`; };
const json = async (response: Response): Promise<Record<string, unknown>> => {
  const value = await response.json();
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const close = async (server: Server): Promise<void> => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };

const fixture = async (t: { after: (fn: () => Promise<void>) => void }, options: { db?: string; separateSecret?: boolean; timeout?: number } = {}) => {
  const calls: { body: Buffer; headers: Record<string, string | string[] | undefined> }[] = [];
  const audits: unknown[] = [];
  let status = 200; let delay = 0;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({ body: Buffer.concat(chunks), headers: req.headers });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    res.writeHead(status, status === 302 ? { location: "http://127.0.0.1:1/leak" } : {});
    res.end("upstream response must not appear in logs");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const config: Config = ConfigSchema.parse({ LINEAR_WEBHOOK_SECRET: secret, T3_WEBHOOK_URL: urlOf(upstream),
    ...(options.separateSecret ? { T3_WEBHOOK_SECRET: destinationSecret } : {}), FORWARD_TIMEOUT_MS: options.timeout ?? 1000 });
  const receipts = new Receipts(options.db ?? ":memory:");
  const server = createApp(config, policy, receipts, item => audits.push(item)).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { await close(server); await close(upstream); receipts.close(); });
  const send = async (body = JSON.stringify(event()), headers: Record<string, string> = {}, path = "/linear/webhook") =>
    fetch(urlOf(server) + path, { method: "POST", body, headers: { "content-type": "application/json", "linear-signature": sign(secret, Buffer.from(body)), "linear-delivery": "delivery-one", "linear-event": "Issue", ...headers } });
  return { calls, audits, send, url: urlOf(server), setStatus: (n: number) => { status = n; }, setDelay: (n: number) => { delay = n; } };
};

test("filter matches creates, stage entries and exits, project moves and routing edits", () => {
  for (const value of [
    event({ action: "create", updatedFrom: undefined }),
    event({ data: { id: "issue", projectId: project, stateId: backlog }, updatedFrom: { stateId: active } }),
    event({ data: { id: "issue", projectId: project, stateId: canceled }, updatedFrom: { stateId: todo } }),
    event({ data: { id: "issue", projectId: null, stateId: todo }, updatedFrom: { projectId: project } }),
    event({ updatedFrom: { projectId: null } }),
    event({ updatedFrom: { parentId: null } }),
    event({ updatedFrom: { priority: 0 } }),
    event({ action: "remove", data: { id: "issue", projectId: project, stateId: active } }),
    event({ action: "remove", data: { id: "issue", projectId: project } }),
  ]) assert.equal(classify(value, policy).forward, true, JSON.stringify(value));
});

test("filter drops backlog creation/edits, workpad comments, routine active edits and unrelated projects", () => {
  for (const value of [
    event({ action: "create", data: { id: "issue", projectId: project, stateId: backlog } }),
    event({ type: "Comment", data: { id: "comment", body: "Codex Workpad" } }),
    event({ type: "AgentSessionEvent" }),
    event({ organizationId: "other" }),
    event({ data: { id: "issue", projectId: "other", stateId: todo } }),
    event({ data: { id: "issue", projectId: project, stateId: backlog }, updatedFrom: { priority: 0 } }),
    event({ data: { id: "issue", projectId: project, stateId: backlog }, updatedFrom: { stateId: canceled } }),
    event({ updatedFrom: { description: "old workpad", updatedAt: "old" } }),
    event({ updatedFrom: { stateId: todo } }),
    event({ action: "remove", data: { id: "issue", projectId: project, stateId: backlog } }),
  ]) assert.equal(classify(value, policy).forward, false, JSON.stringify(value));
});

test("signed raw bytes and delivery headers reach the destination unchanged", async t => {
  const f = await fixture(t); const raw = JSON.stringify(event(), null, 2) + "\n";
  const response = await f.send(raw, { "linear-timestamp": "1770000000000" });
  assert.equal(response.status, 200); assert.equal((await json(response)).forwarded, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.toString(), raw);
  assert.equal(f.calls[0].headers["linear-signature"], sign(secret, Buffer.from(raw)));
  assert.equal(f.calls[0].headers["linear-delivery"], "delivery-one");
  assert.equal(f.calls[0].headers["linear-timestamp"], "1770000000000");
});

test("optional separate destination secret re-signs only the original raw bytes", async t => {
  const f = await fixture(t, { separateSecret: true }); const raw = JSON.stringify(event());
  assert.equal((await f.send(raw)).status, 200);
  assert.equal(f.calls[0].headers["linear-signature"], sign(destinationSecret, Buffer.from(raw)));
  assert.equal(f.calls[0].body.toString(), raw);
});

test("irrelevant authenticated events return 200 and make zero downstream requests", async t => {
  const f = await fixture(t);
  for (const payload of [event({ type: "Comment" }), event({ updatedFrom: { title: "old" } }),
    event({ action: "create", data: { id: "issue", projectId: project, stateId: backlog } })]) {
    const response = await f.send(JSON.stringify(payload));
    assert.equal(response.status, 200); assert.equal((await json(response)).forwarded, false);
  }
  assert.equal(f.calls.length, 0);
});

test("invalid signatures, stale/future timestamps, malformed JSON and partial active issues fail closed", async t => {
  const f = await fixture(t);
  for (const signature of ["", "bad", "d".repeat(64), "0".repeat(63) + "g"]) {
    assert.equal((await f.send(JSON.stringify(event()), { "linear-signature": signature })).status, 401);
  }
  for (const timestamp of [Date.now() - 400000, Date.now() + 120000, "invalid", null]) {
    assert.equal((await f.send(JSON.stringify(event({ webhookTimestamp: timestamp })))).status, 401);
  }
  assert.equal((await f.send("{bad JSON}")).status, 400);
  assert.equal((await f.send(JSON.stringify(event({ data: { id: "issue", projectId: project } })))).status, 400);
  assert.equal(f.calls.length, 0);
});

test("body limits, content type and removed execution/OAuth routes", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("x".repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await f.send(JSON.stringify(event()), { "content-type": "text/plain" })).status, 415);
  for (const path of ["/github/webhook", "/linear/install", "/linear/oauth/callback"]) {
    assert.equal((await f.send(undefined, {}, path)).status, 404);
  }
  assert.equal((await fetch(f.url + "/linear/install")).status, 404);
  assert.equal((await fetch(f.url + "/healthz")).status, 200);
  assert.equal(f.calls.length, 0);
});

test("successful receipt prevents retry and survives service/store restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "filter-test-")); t.after(async () => { rmSync(dir, { recursive: true, force: true }); });
  const db = join(dir, "receipts.sqlite"); const raw = JSON.stringify(event());
  const first = await fixture(t, { db });
  assert.equal((await first.send(raw)).status, 200);
  const second = await fixture(t, { db });
  const response = await second.send(raw, { "linear-delivery": "retry-with-different-header" });
  assert.equal((await json(response)).reason, "duplicate");
  assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 0);
});

test("concurrent duplicate delivery does not forward twice", async t => {
  const f = await fixture(t); f.setDelay(80); const raw = JSON.stringify(event());
  const responses = await Promise.all([f.send(raw), f.send(raw)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 503]); assert.equal(f.calls.length, 1);
  assert.equal((await json(await f.send(raw))).reason, "duplicate");
});

test("destination rejection and timeout permit a subsequent retry without leaking error details", async t => {
  const f = await fixture(t, { timeout: 60 }); const raw = JSON.stringify(event());
  f.setStatus(500); assert.equal((await f.send(raw)).status, 503);
  f.setStatus(200); f.setDelay(150); assert.equal((await f.send(raw)).status, 503);
  f.setDelay(0); assert.equal((await f.send(raw)).status, 200);
  assert.equal(f.calls.length, 3);
  assert.ok(!JSON.stringify(f.audits).includes(secret));
  assert.ok(!JSON.stringify(f.audits).includes("upstream response"));
});

test("redirects are refused rather than forwarding credentials elsewhere", async t => {
  const f = await fixture(t); f.setStatus(302);
  assert.equal((await f.send()).status, 503); assert.equal(f.calls.length, 1);
});

test("an interrupted lease recovers; completed receipts expire after retention", () => {
  const receipts = new Receipts(":memory:");
  assert.equal(receipts.claim("a", 0), "claimed"); assert.equal(receipts.claim("a", 1), "busy");
  assert.equal(receipts.claim("a", 10001), "claimed"); receipts.delivered("a", 10002);
  assert.equal(receipts.claim("a", 10003), "delivered");
  assert.equal(receipts.claim("a", 10003 + 8 * 86400000), "claimed"); receipts.close();
});

test("configuration excludes old orchestration requirements and rejects unsafe destination/policy", () => {
  assert.ok(ConfigSchema.safeParse({ LINEAR_WEBHOOK_SECRET: secret, T3_WEBHOOK_URL: "https://relay.example/hook" }).success);
  for (const url of ["http://attacker.example/hook", "https://user:password@example.com/hook", "file:///tmp/a"]) {
    assert.equal(ConfigSchema.safeParse({ LINEAR_WEBHOOK_SECRET: secret, T3_WEBHOOK_URL: url }).success, false);
  }
  assert.equal(PolicySchema.safeParse({ ...policy, trackedStateIds: [active] }).success, false);
  assert.equal(PolicySchema.safeParse({ ...policy, projectIds: [] }).success, false);
  assert.equal(ConfigSchema.safeParse({ LINEAR_WEBHOOK_SECRET: secret, T3_WEBHOOK_URL: "https://relay.example/hook", FORWARDER_DB_PATH: "./data/bridge.sqlite" }).success, false);
});
