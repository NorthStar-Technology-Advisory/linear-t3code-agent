import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "dotenv";
const command = path.resolve("src/onboarding.ts");
async function run(cwd: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), command, ...args], {
    cwd, env: { PATH: process.env.PATH, HOME: cwd, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  child.stdin.end(input);
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  return { code, output };
}
test("setup saves each answer privately and resumes without replacing saved values", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "onboarding-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, ".env"), '# preserved\nCUSTOM="keep me"\nT3CODE_URL=http://127.0.0.1:1\n');
  const first = await run(cwd, ["setup"], "https://bridge.example\n");
  assert.equal(first.code, 1);
  let env = parse(await readFile(path.join(cwd, ".env")));
  assert.equal(env.BASE_URL, "https://bridge.example");
  assert.equal(env.LINEAR_REDIRECT_URI, "https://bridge.example/linear/oauth/callback");
  assert.ok(env.INSTALL_SECRET.length >= 32);
  const secret = env.INSTALL_SECRET;
  assert.equal((await stat(path.join(cwd, ".env"))).mode & 0o777, 0o600);
  const second = await run(cwd, ["setup"], "private-token\nclient-id\nclient-secret\nwebhook-secret\nNOR-199\n");
  env = parse(await readFile(path.join(cwd, ".env")));
  assert.equal(env.INSTALL_SECRET, secret);
  assert.equal(env.CUSTOM, "keep me");
  assert.equal(env.T3CODE_TOKEN, "private-token");
  assert.doesNotMatch(second.output, /private-token|client-secret|webhook-secret/);
  assert.match(second.output, /oauth.client_name=T3Code/);
  assert.match(second.output, /webhook.resourceTypes=AgentSessionEvent/);
  assert.match(second.output, /developer/);
  const third = await run(cwd, ["setup"]);
  assert.doesNotMatch(third.output, /applications\/new/);
  assert.equal(parse(await readFile(path.join(cwd, ".env"))).INSTALL_SECRET, secret);
});

test("doctor runs independent checks with incomplete configuration and leaves files unchanged", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "doctor-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = "# private\nCUSTOM=unchanged\n";
  await writeFile(path.join(cwd, ".env"), source);
  const result = await run(cwd, ["doctor"], "", { PATH: "/missing-tools" });
  assert.equal(result.code, 1);
  assert.match(result.output, /FAIL configuration/);
  assert.match(result.output, /FAIL git/);
  assert.match(result.output, /FAIL GitHub/);
  assert.match(result.output, /FAIL Linear installation/);
  assert.match(result.output, /UNVERIFIED actual Linear webhook receipt/);
  assert.match(result.output, /UNVERIFIED end-to-end delivery/);
  assert.equal(await readFile(path.join(cwd, ".env"), "utf8"), source);
});

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "doctor-services-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await promisify(execFile)("git", ["init", cwd]);
  await promisify(execFile)("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
  await promisify(execFile)("git", ["-C", cwd, "config", "user.name", "Test"]);
  await promisify(execFile)("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  await mkdir(path.join(cwd, "bin"));
  await writeFile(path.join(cwd, "bin/gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const observed: string[] = [];
  const state = { t3Status: 200, linearStatus: 200, duplicate: false, unmatched: false, inaccessible: false, incompatible: false, settingsInvalid: false };
  const project = { id: "t3-project", title: "Example project", workspaceRoot: cwd, deletedAt: null, defaultModelSelection: null };
  const service = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    observed.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url === "/healthz") return send({ ok: true, service: "linear-t3code-agent" });
    if (req.url === "/graphql") {
      res.statusCode = state.linearStatus;
      const query = JSON.parse(body).query; observed.push(query);
      if (query.includes("DoctorViewer")) return send({ data: { viewer: { id: "app", app: true } } });
      if (query.includes("DoctorIssue")) return send({ data: { issue: { project: { id: "linear-project" } } } });
      if (query.includes("BridgeProjectConfig")) return send({ data: { project: { content: `\`\`\`yaml\nt3code:\n  version: 1\n  project: "${state.unmatched ? "wrong title" : "Example project"}"\n  workflows:\n    - team: NOR\n      statuses:\n        Todo:\n          prompt: Implement this issue.\n          output: draft-pr\n\`\`\`` } } });
      if (query.includes("BridgeProjectTeams")) return send({ data: { project: { teams: { nodes: [{ id: "team-1", key: "NOR" }], pageInfo: { hasNextPage: false } } } } });
      return send({ data: { team: { states: { nodes: [{ id: "todo", name: "Todo" }], pageInfo: { hasNextPage: false } } } } });
    }
    if (req.url === "/api/orchestration/snapshot") {
      res.statusCode = state.t3Status;
      if (state.incompatible) return send({ bad: "contract" });
      return send({ projects: [{ ...project, workspaceRoot: state.inaccessible ? path.join(cwd, "missing") : cwd }, ...(state.duplicate ? [{ ...project, id: "duplicate" }] : [])] });
    }
    if (req.url === "/api/auth/websocket-ticket") return send({ ticket: "temporary-ticket" });
    res.statusCode = 500; send({ error: "Unexpected work-producing request" });
  });
  const sockets = new WebSocketServer({ server: service, path: "/ws" });
  sockets.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw)); observed.push(request.tag);
    const response = request.tag === "server.getSettings" ? state.settingsInvalid ? {} : { defaultModelSelection: { instanceId: "codex", model: "test-model" }, defaultThreadEnvMode: "worktree", newWorktreesStartFromOrigin: true, providerInstances: {}, providers: { codex: { enabled: true } } } : request.tag === "server.getConfig" ? { providers: [{ instanceId: "codex", enabled: true, installed: true, models: [{ slug: "test-model" }] }] } : { isRepo: true, refs: [{ name: "main", isDefault: true }], nextCursor: null };
    socket.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: response } }));
  }));
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  t.after(() => { sockets.clients.forEach(s => s.terminate()); sockets.close(); service.close(); });
  const address = service.address(); if (!address || typeof address === "string") throw new Error("address");
  const origin = `http://127.0.0.1:${address.port}`;
  // Redirect only the two fixed external services; leave real HTTP/RPC transports intact.
  await writeFile(path.join(cwd, "network.mjs"), `const original=globalThis.fetch;globalThis.fetch=(url,options)=>{const text=String(url);return original(text==='https://api.linear.app/graphql'?'${origin}/graphql':text==='https://bridge.example/healthz'?'${origin}/healthz':url,options)};`);
  const env = { PATH: `${cwd}/bin:${process.env.PATH}`, NODE_OPTIONS: `--import=${cwd}/network.mjs` };
  const values = { BASE_URL: "https://bridge.example", LINEAR_REDIRECT_URI: "https://bridge.example/linear/oauth/callback", INSTALL_SECRET: "private-install-secret", LINEAR_CLIENT_ID: "client", LINEAR_CLIENT_SECRET: "client-secret", LINEAR_WEBHOOK_SECRET: "webhook-secret", T3CODE_URL: origin, T3CODE_TOKEN: "private-token", TOKEN_STORE_PATH: "tokens.json", PORT: String(address.port), SETUP_ISSUE: "NOR-1", CUSTOM: "preserved" };
  await writeFile(path.join(cwd, ".env"), Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  await writeFile(path.join(cwd, "tokens.json"), JSON.stringify({ default_app_user_id: "app", installations: { app: { access_token: "private-linear-token", expires_at: Date.now() + 3600000, scope: "read,write,app:assignable,app:mentionable" } } }));
  await writeFile(path.join(cwd, "session-state"), "preserve sessions");
  return { cwd, env, state, observed };
}

test("completed setup and doctor inspect services without producing work or changing state", async t => {
  const f = await fixture(t);
  const files = [".env", "tokens.json", "session-state"];
  const before = await Promise.all(files.map(file => readFile(path.join(f.cwd, file), "utf8")));
  for (const mode of ["doctor", "setup"]) {
    const result = await run(f.cwd, [mode], "", f.env);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /PASS project association/);
    assert.match(result.output, /PASS effective settings/);
    assert.match(result.output, /Setup complete: configuration and available connection checks passed/);
    assert.match(result.output, /Delivery and execution remain unverified/);
    assert.doesNotMatch(result.output, /private-token|private-linear-token|private-install-secret|client-secret|webhook-secret|applications\/new/);
  }
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(f.cwd, file), "utf8"))), before);
  assert.ok(f.observed.every(item => !/mutation|dispatch|refreshProviders|worktree|push|agentActivityCreate/i.test(item)), f.observed.join("\n"));
  const { stdout } = await promisify(execFile)("git", ["-C", f.cwd, "branch", "--list"]);
  assert.equal(stdout.trim().split("\n").length, 1);
});

test("doctor explains auth, contract, association and repository failures independently", async t => {
  const f = await fixture(t);
  for (const [key, value, expected] of [
    ["t3Status", 401, /FAIL T3Code: Authentication rejected/],
    ["linearStatus", 403, /FAIL Linear installation: Authentication rejected/],
    ["incompatible", true, /FAIL T3Code: API incompatible/],
    ["duplicate", true, /FAIL project association: Multiple/],
    ["unmatched", true, /FAIL project association: No active/],
    ["inaccessible", true, /FAIL repository access/],
    ["settingsInvalid", true, /FAIL effective settings/],
  ] as const) {
    const previous = f.state[key]; Object.assign(f.state, { [key]: value });
    const result = await run(f.cwd, ["doctor"], "", f.env);
    assert.equal(result.code, 1, result.output); assert.match(result.output, expected);
    assert.match(result.output, /PASS bridge process/);
    Object.assign(f.state, { [key]: previous });
  }
});

test("explicit credential correction rechecks successfully and preserves installation and sessions", async t => {
  const f = await fixture(t);
  const tokens = await readFile(path.join(f.cwd, "tokens.json"), "utf8");
  const result = await run(f.cwd, ["setup", "--replace", "T3CODE_TOKEN"], "new-private-token\n", f.env);
  assert.equal(result.code, 0, result.output);
  assert.equal(parse(await readFile(path.join(f.cwd, ".env"))).T3CODE_TOKEN, "new-private-token");
  assert.doesNotMatch(result.output, /new-private-token/);
  assert.equal(await readFile(path.join(f.cwd, "tokens.json"), "utf8"), tokens);
  assert.equal(await readFile(path.join(f.cwd, "session-state"), "utf8"), "preserve sessions");
});

test("setup refuses non-public and credential-bearing public addresses before saving", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "setup-address-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await run(cwd, ["setup"], "https://user:secret@bridge.example\nhttps://127.0.0.1\nhttps://192.168.1.1\nhttps://linear.app\nhttps://bridge.example/path\nhttps://bridge.example\n");
  assert.equal(result.code, 1);
  assert.equal(parse(await readFile(path.join(cwd, ".env"))).BASE_URL, "https://bridge.example");
  assert.doesNotMatch(result.output, /user:secret/);
});

test("doctor reports missing app scopes and expired credentials without refreshing tokens", async t => {
  const f = await fixture(t);
  const tokenFile = path.join(f.cwd, "tokens.json");
  const store = JSON.parse(await readFile(tokenFile, "utf8"));
  store.installations.app.scope = "read";
  await writeFile(tokenFile, JSON.stringify(store));
  const missing = await run(f.cwd, ["doctor"], "", f.env);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /FAIL Linear installation:.*scopes/);
  store.installations.app.expires_at = 1;
  await writeFile(tokenFile, JSON.stringify(store));
  const expired = await run(f.cwd, ["doctor"], "", f.env);
  assert.match(expired.output, /expired installation/);
  assert.equal(await readFile(tokenFile, "utf8"), JSON.stringify(store));
  assert.ok(f.observed.every(value => !value.includes("oauth/token")));
});

test("credential replacement preserves assignment-looking text inside multiline values", async t => {
  const f = await fixture(t);
  const file = path.join(f.cwd, ".env");
  const source = (await readFile(file, "utf8")).replace("T3CODE_TOKEN=private-token\n", "") + 'CUSTOM="first\nT3CODE_TOKEN=inside-custom\nlast"\n';
  await writeFile(file, source);
  const result = await run(f.cwd, ["setup"], "new-token\n", f.env);
  assert.equal(result.code, 0, result.output);
  const saved = parse(await readFile(file, "utf8"));
  assert.equal(saved.T3CODE_TOKEN, "new-token");
  assert.equal(saved.CUSTOM, "first\nT3CODE_TOKEN=inside-custom\nlast");
});

test("Linear timeout reports connectivity repair, not reinstall", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "timeout.mjs"), "const original=globalThis.fetch;globalThis.fetch=(url,options)=>String(url)==='https://api.linear.app/graphql'?Promise.reject(new DOMException('Timed out','TimeoutError')):original(url,options);");
  const result = await run(f.cwd, ["doctor"], "", { ...f.env, NODE_OPTIONS: `${f.env.NODE_OPTIONS} --import=${f.cwd}/timeout.mjs` });
  assert.equal(result.code, 1);
  assert.match(result.output, /FAIL Linear installation: Connection failed/);
});
