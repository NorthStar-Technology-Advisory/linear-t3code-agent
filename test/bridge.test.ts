import { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PullRequest } from "../src/pull-requests.js";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";

Object.assign(process.env, {
  NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null",
  LINEAR_CLIENT_ID: "client", LINEAR_CLIENT_SECRET: "client-secret",
  LINEAR_WEBHOOK_SECRET: "webhook-secret", LINEAR_REDIRECT_URI: "https://example.com/linear/oauth/callback",
  BASE_URL: "https://example.com", T3CODE_URL: "http://127.0.0.1:3773",
  T3CODE_TOKEN: "t3-secret", T3CODE_PROVIDER: "codex", T3CODE_MODEL: "test-model",
  PROJECT_ROUTES: '{}',
});

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "nor173-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
  const commands: any[] = [];
  const activities: any[] = [];
  const threads = new Map<string, any>();
  const events: any[] = [];
  const attachmentRequests: string[] = [];
  let sequence = 0;
  const issueOverrides: Record<string, any> = {};
  const reads: any[] = [];
  const faults = { dropAcceptedTurn: false, rejectBeforeTurn: false, linearDown: false, dropActivity: false, snapshotDown: false, deferStop: false, replayFallback: false, rejectAnswer: false };
  const pr: PullRequest = { number: 42, url: "https://github.com/test/repo/pull/42", state: "OPEN", isDraft: true, headRefName: "" };
  const external = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/attachment") {
      assert.equal(req.headers.authorization, "Bearer linear-secret");
      res.end("Linear attachment content"); return;
    }
    if (req.url === "/graphql") {
      assert.equal(req.headers.authorization, "Bearer linear-secret");
      const { query, variables } = JSON.parse(raw);
      if (query.includes("AgentActivityCreate")) {
        if (faults.linearDown) { res.statusCode = 503; res.end('{}'); return; }
        if (!activities.some(a => a.id === variables.input.id)) activities.push(variables.input);
        if (faults.dropActivity) { faults.dropActivity = false; res.destroy(); return; }
        res.end(JSON.stringify({ data: { agentActivityCreate: { success: true, agentActivity: { id: variables.input.id } } } }));
      } else if (query.includes("BridgeActivity")) {
        if (faults.linearDown) { res.statusCode = 503; res.end('{}'); return; }
        res.end(JSON.stringify({ data: { agentSession: { activities: { nodes: activities.filter(a => a.id === variables.id).map(a => ({ id: a.id })) } } } }));
      } else {
        reads.push(variables);
        res.end(JSON.stringify({ data: { issue: { id: "issue-1", identifier: "NOR-1", title: "Make a change", description: "Use https://example.org/design", url: "https://linear.app/test/issue/NOR-1", project: { id: "project-1" }, team: { id: "team-1" }, comments: { nodes: [], pageInfo: { hasNextPage: false } }, attachments: { nodes: [], pageInfo: { hasNextPage: false } }, relations: { nodes: [], pageInfo: { hasNextPage: false } }, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } }, ...issueOverrides[variables.id], ...(variables.after ? issueOverrides[variables.id + ":" + variables.after] : {}) } } }));
      }
    } else {
      assert.equal(req.headers.authorization, "Bearer t3-secret");
      if (req.url === "/api/auth/websocket-ticket") { res.end(JSON.stringify({ ticket: "test-ticket", expiresAt: new Date(Date.now() + 30000).toISOString() })); }
      else if (req.url === "/api/orchestration/dispatch") {
        const command = JSON.parse(raw);
        if (faults.rejectAnswer && command.type === "thread.user-input.respond") { faults.rejectAnswer = false; res.statusCode = 400; res.end("{}"); return; }
        if (faults.rejectBeforeTurn && command.type === "thread.turn.start") { faults.rejectBeforeTurn = false; res.statusCode = 503; res.end('{}'); return; }
        if (!commands.some(c => c.commandId === command.commandId)) {
          commands.push(command);
          sequence++;
          if (command.type === "thread.create") threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, branch: command.branch, worktreePath: command.worktreePath, messages: [], activities: [], latestTurn: null, session: null });
          if (command.type === "thread.turn.start") {
            const thread = threads.get(command.threadId);
            thread.messages.push({ id: command.message.messageId, role: "user", text: command.message.text, turnId: command.message.messageId });
            thread.latestTurn = { turnId: command.message.messageId, state: "running" };
            thread.session = { status: "running", activeTurnId: command.message.messageId, lastError: null };
          }
          if (command.type === "thread.session.stop" && !faults.deferStop) {
            const thread = threads.get(command.threadId);
            thread.session = { status: "stopped", activeTurnId: null, lastError: null };
            if (thread.latestTurn) thread.latestTurn.state = "interrupted";
          }
        }
        if (faults.dropAcceptedTurn && command.type === "thread.turn.start") { faults.dropAcceptedTurn = false; res.destroy(); return; }
        res.end(JSON.stringify({ sequence }));
      } else if (req.url?.startsWith("/api/orchestration/threads/")) {
        if (faults.snapshotDown) { res.statusCode = 503; res.end("{}"); return; }
        const thread = threads.get(decodeURIComponent(req.url.split("/").at(-1)!));
        if (!thread) { res.statusCode = 404; res.end('{}'); }
        else res.end(JSON.stringify({ snapshotSequence: Math.max(sequence, ...events.map(e => e.sequence)), thread }));
      } else if (req.url === "/api/orchestration/snapshot") {
        res.end(JSON.stringify({ snapshotSequence: sequence, projects: [{ id: "t3-project", workspaceRoot: repo }], threads: [...threads.values()] }));
      } else { res.statusCode = 404; res.end('{}'); }
    }
  });
  const sockets = new WebSocketServer({ server: external, path: "/ws" });
  sockets.on("connection", (socket, request) => {
    assert.match(request.url!, /wsTicket=test-ticket/);
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      if (message._tag !== "Request") return;
      assert.equal(message.tag, "orchestration.subscribeThread");
      if (faults.replayFallback) {
        faults.replayFallback = false; sequence += 1001;
        socket.send(JSON.stringify({ _tag: "Chunk", requestId: message.id, values: [{ kind: "snapshot", snapshot: { snapshotSequence: sequence, thread: threads.get(message.payload.threadId) } }, { kind: "synchronized" }] }));
        return;
      }
      const replay = events.filter(e => e.sequence > message.payload.afterSequence && e.payload.threadId === message.payload.threadId);
      socket.send(JSON.stringify({ _tag: "Chunk", requestId: message.id, values: [...replay.map(event => ({ kind: "event", event })), { kind: "synchronized" }] }));
    });
  });
  const externalUrl = await listen(external);
  t.after(async () => { if (external.listening) await close(external); await rm(root, { recursive: true, force: true }); });
  const tokenPath = path.join(root, "tokens.json");
  await writeFile(tokenPath, JSON.stringify({ default_app_user_id: "app", installations: { app: { access_token: "linear-secret", expires_at: Date.now() + 365 * 24 * 3600000 } } }));
  process.env.TOKEN_STORE_PATH = tokenPath;
  const { Bridge } = await import("../src/bridge.js");
  const { T3CodeRunner } = await import("../src/t3code-runner.js");
  const { LinearClient } = await import("../src/linear-context.js");
  const { createApp } = await import("../src/server.js");
  const options = {
    databasePath: path.join(root, "bridge.sqlite"), worktreeRoot: path.join(root, "worktrees"),
    routes: { "project-1": { repository: repo, t3ProjectId: "t3-project", provider: "codex", model: "test-model", baseBranch: "main" } },
    pullRequests: { find: async (_route: unknown, branch: string) => ({ ...pr, headRefName: branch }) },
    prPollMs: 0,
    concurrency: 1, runner: new T3CodeRunner(externalUrl, "t3-secret"),
    linear: new LinearClient(externalUrl + "/graphql", tokenPath, async (input, init) => { attachmentRequests.push(String(input)); return fetch(externalUrl + "/attachment", init); }),
    pollMs: 10, heartbeatMs: 300000, progressDebounceMs: 3000,
  };
  let bridge = new Bridge(options);
  let app = createServer(createApp(bridge));
  let url = await listen(app);
  t.after(async () => { await close(app); await bridge.close(); if (external.listening) await close(external); await rm(root, { recursive: true, force: true }); });
  const send = async (payload: object, signature = true) => {
    const body = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: Date.now(), ...payload });
    return fetch(url + "/linear/webhook", { method: "POST", headers: { "content-type": "application/json", "linear-signature": signature ? createHmac("sha256", "webhook-secret").update(body).digest("hex") : "bad" }, body });
  };
  return { commands, activities, threads, events, attachmentRequests, repo, root, send, issueOverrides, reads, pr, faults, options,
    tick: async (n = 8) => { for (let i = 0; i < n; i++) await bridge.tick(); },
    restart: async () => { await close(app); await bridge.close(); bridge = new Bridge(options); app = createServer(createApp(bridge)); url = await listen(app); },
  };
}
const delegation = (session = "session-1") => ({ action: "created", organizationId: "workspace-1", agentSession: { id: session, issue: { id: "issue-1" } } });

test("signed delegation creates one isolated configured T3Code turn and reports intake", async t => {
  const f = await fixture(t);
  assert.equal((await f.send(delegation(), false)).status, 401);
  assert.equal((await f.send({ ...delegation(), webhookTimestamp: 1 })).status, 401);
  assert.equal((await f.send(delegation())).status, 200);
  await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  const start = f.commands.find(c => c.type === "thread.turn.start");
  assert.ok(start);
  assert.deepEqual(start.modelSelection, { instanceId: "codex", model: "test-model" });
  assert.equal(start.runtimeMode, "full-access");
  assert.match(start.message.text, /Make a change/);
  assert.match(start.message.text, /https:\/\/example.org\/design/);
  const thread = f.commands.find(c => c.type === "thread.create");
  assert.notEqual(thread.worktreePath, f.repo);
  assert.equal(execFileSync("git", ["-C", thread.worktreePath, "branch", "--show-current"], { encoding: "utf8" }).trim(), thread.branch);
  assert.ok(f.activities.some(a => a.content.type === "thought"));
});

test("Linear created webhook with null guidance starts one durable turn", async t => {
  const f = await fixture(t);
  const payload = { ...delegation(), guidance: null, promptContext: "Implement the delegated issue." };
  assert.equal((await f.send(payload)).status, 200);
  await f.restart();
  assert.equal((await f.send(payload)).status, 200);
  await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 1);
  assert.match(turns[0].message.text, /Implement the delegated issue/);
});

const followup = (id: string, body: string, session = "session-1", signal?: string) => ({ ...delegation(session), action: "prompted", agentActivity: { id, signal, content: { type: "prompt", body } } });
function finish(f: Awaited<ReturnType<typeof fixture>>, state = "completed") {
  const thread = [...f.threads.values()][0];
  thread.latestTurn.state = state;
  thread.session = { status: state === "error" ? "error" : "ready", activeTurnId: null, lastError: null };
  thread.messages.push({ id: "answer-" + thread.latestTurn.turnId, role: "assistant", text: '<bridge-result>{"status":"complete","summary":"Implemented","validation":[{"command":"npm test","status":"passed","details":"tests passed"}],"blockers":[],"context":{"read":["issue"],"summarized":[],"unavailable":[]}}</bridge-result>',  turnId: thread.latestTurn.turnId });
}

test("duplicate deliveries and queued follow-ups survive restart in arrival order; failures pause the queue", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  await f.send(followup("activity-1", "First follow-up"));
  await f.send(followup("activity-2", "Second follow-up"));
  await f.send(followup("activity-1", "First follow-up"));
  await f.restart();
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  finish(f); await f.tick();
  let turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.match(turns[1].message.text, /First follow-up/);
  finish(f, "error"); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  await f.send(followup("resume-1", "resume")); await f.tick();
  turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 3);
  assert.match(turns[2].message.text, /Second follow-up/);
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  assert.ok(f.activities.some(a => a.content.type === "error" && /paused/i.test(a.content.body)));
});

test("Linear stop signal clears queued work, preserves edits, ignores late completion and permits later resumption", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  await writeFile(path.join(thread.worktreePath, "partial.txt"), "keep this work");
  await f.send(followup("queued", "must be cleared"));
  await f.send(followup("stop", "", "session-1", "stop"));
  await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.interrupt").length, 1);
  const before = f.activities.filter(a => a.content.type === "response").length;
  finish(f); await f.restart(); await f.tick();
  assert.equal(f.activities.filter(a => a.content.type === "response").length, before);
  assert.match(execFileSync("git", ["-C", thread.worktreePath, "status", "--porcelain"], { encoding: "utf8" }), /partial.txt/);
  await f.send(followup("new", "continue with a different task")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  assert.match(f.commands.filter(c => c.type === "thread.turn.start")[1].message.text, /different task/);
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
});

test("context includes paginated comments, direct relations and attachment content, and refreshes before follow-ups", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = {
    comments: { nodes: [{ id: "c1", body: "First discussion", createdAt: "2026-01-01", user: { name: "Alex" } }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } },
    relations: { nodes: [{ type: "blocks", relatedIssue: { id: "issue-2", url: "https://linear.app/test/issue/NOR-2" } }], pageInfo: { hasNextPage: false } },
    attachments: { nodes: [{ id: "a1", title: "Design notes", url: "https://example.org/external", bodyData: "Attached requirements" }], pageInfo: { hasNextPage: false } },
  };
  f.issueOverrides["issue-1:cursor-1"] = { comments: { nodes: [{ id: "c2", body: "Later discussion", createdAt: "2026-01-02", user: { name: "Sam" } }], pageInfo: { hasNextPage: false } } };
  f.issueOverrides["issue-2"] = { id: "issue-2", title: "Direct dependency", description: "Related requirement" };
  await f.send(delegation()); await f.tick();
  const first = f.commands.find(c => c.type === "thread.turn.start").message.text;
  for (const text of ["First discussion", "Later discussion", "Alex", "Sam", "Direct dependency", "Attached requirements", "externally delegated"]) assert.ok(first.includes(text), text);
  assert.ok(f.reads.some(r => r.after === "cursor-1"));
  finish(f); await f.tick();
  f.issueOverrides["issue-1"].description = "Updated requirements";
  await f.send(followup("refresh", "Use the new requirements")); await f.tick();
  const second = f.commands.filter(c => c.type === "thread.turn.start")[1].message.text;
  assert.match(second, /Updated requirements/);
  assert.match(second, /Context changed/);
});

test("questions and explicit approvals are correlated across restart while unrelated work stays queued", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "event-1", kind: "approval.requested", tone: "approval", summary: "Allow command?", turnId: thread.latestTurn.turnId, payload: { requestId: "approval-1", detail: "Run deployment check" } });
  await f.tick();
  assert.ok(f.activities.some(a => a.content.type === "elicitation" && /approval-1/.test(a.content.body)));
  await f.restart();
  await f.send(followup("unrelated", "Also update the README"));
  await f.send(followup("ambiguous", "yes")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.approval.respond").length, 0);
  await f.send(followup("approve", "approve approval-1")); await f.tick();
  const approval = f.commands.find(c => c.type === "thread.approval.respond");
  assert.equal(approval.requestId, "approval-1"); assert.equal(approval.decision, "accept");
  thread.activities.push({ id: "event-2", kind: "user-input.requested", tone: "info", summary: "Choose environment", turnId: thread.latestTurn.turnId, payload: { requestId: "question-1", questions: [{ id: "environment", question: "Which environment?", options: [{ label: "staging" }] }] } });
  await f.tick(); await f.restart();
  await f.send(followup("answer", 'answer question-1 {"environment":"staging"}')); await f.tick();
  const answer = f.commands.find(c => c.type === "thread.user-input.respond");
  assert.equal(answer.requestId, "question-1"); assert.deepEqual(answer.answers, { environment: "staging" });
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  finish(f); await f.tick();
  assert.match(f.commands.filter(c => c.type === "thread.turn.start")[1].message.text, /Also update the README/);
});

test("draft PR results include validation; closed PRs reject follow-ups and preserve dirty worktrees", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const prompt = f.commands.find(c => c.type === "thread.turn.start").message.text;
  assert.match(prompt, /draft PR/);
  assert.match(prompt, /never merge/i);
  finish(f); await f.tick();
  assert.ok(f.activities.some(a => a.content.type === "response" && /pull\/42/.test(a.content.body) && /Validation/.test(a.content.body)));
  const thread = [...f.threads.values()][0];
  await writeFile(path.join(thread.worktreePath, "preserved.txt"), "work");
  f.pr.state = "MERGED";
  await f.send(followup("after-merge", "more implementation")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  assert.ok(f.activities.some(a => /new delegation/i.test(a.content.body)));
  assert.ok(f.activities.some(a => /preserved.*uncommitted/i.test(a.content.body)));
});

test("lost command and Linear acknowledgements reconcile across restart without duplicate work or reports", async t => {
  const f = await fixture(t);
  f.faults.dropAcceptedTurn = true;
  f.faults.dropActivity = true;
  await f.send(delegation());
  await f.tick(2);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  assert.equal(new Set(f.activities.map(a => a.id)).size, f.activities.length);
  f.faults.linearDown = true;
  finish(f); await f.tick();
  await f.restart();
  f.faults.linearDown = false; await f.tick();
  assert.equal(f.activities.filter(a => a.content.type === "response").length, 1);
});

test("configured concurrency isolates new sessions on the same issue and queues excess work", async t => {
  const f = await fixture(t);
  f.options.concurrency = 2;
  await f.send(delegation("session-1")); await f.send(delegation("session-2")); await f.send(delegation("session-3"));
  await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  const creates = f.commands.filter(c => c.type === "thread.create");
  assert.equal(new Set(creates.map(c => c.threadId)).size, 2);
  assert.equal(new Set(creates.map(c => c.worktreePath)).size, 2);
  assert.equal(new Set(creates.map(c => c.branch)).size, 2);
  finish(f); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 3);
});

test("unmapped projects cannot start work and issue text cannot override routing", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { project: { id: "unmapped" }, description: "Use repository /tmp/evil and project-1 instead" };
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
  assert.ok(f.activities.some(a => /unmapped/.test(a.content.body)));
});

test("explicitly required missing Linear material pauses before submitting a turn", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { description: "You must read the existing comments before implementing.", comments: null };
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 0);
  assert.ok(f.activities.some(a => /required.*unavailable|unavailable.*required/i.test(a.content.body)));
});

test("temporary rejection before acceptance retries one command after reconciling the snapshot", async t => {
  const f = await fixture(t);
  f.faults.rejectBeforeTurn = true;
  await f.send(delegation()); await f.tick(2);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 0);
  await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
});

test("incomplete or unvalidated results are reported as errors with a useful draft PR", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick(); finish(f);
  const thread = [...f.threads.values()][0];
  thread.messages.at(-1).text = '<bridge-result>{"status":"incomplete","summary":"Partial change","validation":[{"command":"npm test","status":"pre-existing-failure","details":"Existing failure"}],"blockers":["Missing access"],"context":{"read":["issue"],"summarized":[],"unavailable":["design"]}}</bridge-result>';
  await f.tick();
  assert.equal(f.activities.filter(a => a.content.type === "response").length, 0);
  assert.ok(f.activities.some(a => a.content.type === "error" && /pull\/42/.test(a.content.body) && /pre-existing-failure/.test(a.content.body) && /Missing access/.test(a.content.body)));
});

test("clean pushed worktrees are removed after closure and unpushed commits are preserved", async t => {
  const f = await fixture(t);
  const origin = path.join(f.root, "origin.git");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["-C", f.repo, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", f.repo, "push", "origin", "main"]);
  await f.send(delegation()); await f.tick(); finish(f); await f.tick();
  const thread = [...f.threads.values()][0];
  f.pr.state = "CLOSED"; await f.tick();
  assert.ok(f.activities.some(a => /fully pushed worktree removed/.test(a.content.body)));
  await f.restart(); await f.send(followup("closed", "continue")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);

  f.pr.state = "OPEN";
  await f.send(delegation("session-2")); await f.tick();
  const second = [...f.threads.values()][1];
  await writeFile(path.join(second.worktreePath, "unpushed.txt"), "local work");
  execFileSync("git", ["-C", second.worktreePath, "add", "unpushed.txt"]);
  execFileSync("git", ["-C", second.worktreePath, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Local work"]);
  second.latestTurn.state = "completed";
  second.messages.push({ ...thread.messages.at(-1), turnId: second.latestTurn.turnId });
  await f.tick(); f.pr.state = "CLOSED"; await f.tick();
  assert.ok(f.activities.some(a => /preserved.*commits are not reachable/.test(a.content.body)));
});

test("event catch-up restores a pending question omitted from the bounded snapshot", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  // Real snapshots retain only 500 activities. This request exists in the event log alone.
  f.events.push({ type: "thread.activity-appended", sequence: 3, payload: { threadId: thread.id, activity: { id: "older-request", kind: "user-input.requested", tone: "info", summary: "Missing design", turnId: thread.latestTurn.turnId, payload: { requestId: "old-question", questions: [{ id: "design", question: "Where is the required design?" }] } } } });
  await f.restart(); await f.tick();
  assert.ok(f.activities.some(a => a.content.type === "elicitation" && /old-question/.test(a.content.body)));
});

test("stop acknowledgement cannot release queued work until the provider has stopped", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  f.faults.deferStop = true;
  await f.send(followup("stop-pending", "stop")); await f.tick();
  await f.send(followup("later", "resume after stop")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  const thread = [...f.threads.values()][0];
  thread.session = { status: "stopped", activeTurnId: null, lastError: null };
  thread.latestTurn.state = "interrupted";
  await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
});

test("progress is debounced, secrets are redacted and elapsed time does not expire work or questions", async t => {
  const f = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.options.progressDebounceMs = 100;
  f.options.heartbeatMs = 1000;
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "p1", kind: "tool.started", tone: "tool", summary: "Checking t3-secret linear-secret client-secret", turnId: thread.latestTurn.turnId, payload: {} });
  await f.tick();
  assert.ok(!f.activities.some(a => /Checking/.test(a.content.body)));
  now += 101; await f.tick();
  assert.equal(f.activities.filter(a => /Checking/.test(a.content.body)).length, 1);
  assert.doesNotMatch(JSON.stringify(f.activities), /t3-secret|linear-secret|client-secret/);
  now += 7 * 86400000; await f.tick();
  assert.ok(f.activities.some(a => /still working/.test(a.content.body)));
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  thread.activities.push({ id: "wait", kind: "user-input.requested", tone: "info", summary: "Wait", turnId: thread.latestTurn.turnId, payload: { requestId: "wait-1", questions: [{ id: "choice", question: "Which option?" }] } });
  await f.tick(); now += 7 * 86400000; await f.restart(); await f.tick();
  await f.send(followup("late-answer", 'answer wait-1 {"choice":"A"}')); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.user-input.respond").length, 1);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.interrupt").length, 0);
});

test("a second worker cannot execute the same persisted installation", async t => {
  const f = await fixture(t);
  const { Bridge } = await import("../src/bridge.js");
  assert.throws(() => new Bridge(f.options), /Another bridge process owns/);
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
});

test("large replay gaps reconcile fresh snapshots and pinned requests, then resume queued work", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "pinned", kind: "user-input.requested", tone: "info", summary: "Pinned question", turnId: thread.latestTurn.turnId, payload: { requestId: "pinned-1", questions: [{ id: "choice", question: "Choose" }] } });
  f.faults.replayFallback = true;
  await f.restart(); await f.tick();
  assert.ok(f.activities.some(a => /intermediate progress details are unavailable/.test(a.content.body)));
  assert.ok(f.activities.some(a => a.content.type === "elicitation" && /pinned-1/.test(a.content.body)));
  await f.send(followup("pinned-answer", 'answer pinned-1 {"choice":"A"}')); await f.tick();
  await f.send(followup("next-after-gap", "Next task")); finish(f); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
});

test("blank answers stay unsubmitted and definitively rejected answers can be corrected", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "question", kind: "user-input.requested", tone: "info", summary: "Question", turnId: thread.latestTurn.turnId, payload: { requestId: "correctable", responseMode: "message", questions: [{ id: "choice", question: "Choose" }] } });
  await f.tick();
  await f.send(followup("blank", 'answer correctable {"choice":""}')); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.user-input.respond").length, 0);
  f.faults.rejectAnswer = true;
  await f.send(followup("rejected", 'answer correctable {"choice":"invalid"}')); await f.tick();
  assert.ok(f.activities.some(a => /rejected the response/.test(a.content.body)));
  await f.send(followup("corrected", 'answer correctable {"choice":"valid"}')); await f.tick();
  assert.deepEqual(f.commands.find(c => c.type === "thread.user-input.respond").answers, { choice: "valid" });
});

test("Linear uploads are supplied as private content files while external URLs are not fetched by the bridge", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { description: "Read https://uploads.linear.app/workspace/design.pdf and https://example.org/external-doc" };
  await f.send(delegation()); await f.tick();
  assert.deepEqual(f.attachmentRequests, ["https://uploads.linear.app/workspace/design.pdf"]);
  const text = f.commands.find(c => c.type === "thread.turn.start").message.text;
  const saved = /Linear attachment saved as ([^;]+);/.exec(text);
  assert.ok(saved);
  assert.equal(await readFile(saved[1], "utf8"), "Linear attachment content");
  assert.match(text, /externally delegated/);
});

test("oversized follow-ups are supplied completely through a context file", async t => {
  const f = await fixture(t);
  await f.send({ ...delegation(), promptContext: "large-context ".repeat(9000) + "UNIQUE END MARKER" }); await f.tick();
  const text = f.commands.find(c => c.type === "thread.turn.start").message.text;
  assert.ok(text.length < 120000);
  const file = /complete delegated turn at (.+?) before acting/.exec(text);
  assert.ok(file);
  assert.match(await readFile(file[1], "utf8"), /UNIQUE END MARKER$/);
});

test("native multi-select questions preserve selected answers as arrays", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "multi", kind: "user-input.requested", tone: "info", summary: "Choose checks", turnId: thread.latestTurn.turnId, payload: { requestId: "multi-1", questions: [{ id: "checks", question: "Which checks?", multiSelect: true, options: [{ label: "lint" }, { label: "test" }] }] } });
  await f.tick(); await f.restart();
  await f.send(followup("multi-answer", 'answer multi-1 {"checks":["lint","test"]}')); await f.tick();
  assert.deepEqual(f.commands.find(c => c.type === "thread.user-input.respond").answers, { checks: ["lint", "test"] });
});
