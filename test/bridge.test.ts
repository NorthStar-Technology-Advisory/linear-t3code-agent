import { stringify } from "yaml";
import { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PullRequest } from "../src/pull-requests.js";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

Object.assign(process.env, {
  NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null",
  LINEAR_CLIENT_ID: "client", LINEAR_CLIENT_SECRET: "client-secret",
  LINEAR_WEBHOOK_SECRET: "webhook-secret", LINEAR_REDIRECT_URI: "https://example.com/linear/oauth/callback",
  GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "nor173-")));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
  const commands: any[] = [];
  const activities: any[] = [];
  const threads = new Map<string, any>();
  const events: any[] = [];
  const attachmentRequests: string[] = [];
  const projects = [{ id: "t3-project", title: "Test project", workspaceRoot: repo, deletedAt: null as string | null, defaultModelSelection: { instanceId: "codex", model: "test-model" } as any, defaultThreadEnvMode: "worktree" as string | null }];
  const settings: any = { defaultModelSelection: { instanceId: "codex", model: "inherited-model" }, defaultThreadEnvMode: "worktree", newWorktreesStartFromOrigin: false, providerInstances: { codex: { enabled: true } }, providers: {} };
  const skills = ["grill-me", "to-spec", "to-tickets", "implement"].map(name => ({ name, path: `/skills/${name}/SKILL.md`, enabled: true }));
  const providers = [{ instanceId: "codex", enabled: true, installed: true, availability: "available", models: [{ slug: "test-model" }, { slug: "inherited-model" }] }];
  const projectConfig: any = { t3code: { version: 1, project: "Test project", workflows: [{ team: "NOR", statuses: Object.fromEntries(
    [ ["grill-me", "comment"], ["to-spec", "specification"], ["to-tickets", "tickets"], ["implement", "draft-pr"] ].map(([name, output]) => [name, {
      prompt: `Use $${name} for this issue.`, output, "required-skills": [name], ...(name === "implement" ? { "new-thread": true } : {}),
    }])) }] } };
  const projectDocument = { content: undefined as string | undefined };
  const statusNodes = ["grill-me", "to-spec", "to-tickets", "implement", "review"].map(name => ({ id: name, name }));
  let sequence = 0;
  const issueOverrides: Record<string, any> = {};
  let heldIssueRead: { remaining: number; entered: () => void; wait: Promise<void> } | undefined;
  const reads: any[] = [];
  const linearQueries: string[] = [];
  const linearSessions = new Map<string, { id: string; issueId: string; createdAt: string; appUser: { id: string } }>();
  const archivedSessions = new Set<string>();
  const rejectedSessions = new Set<string>();
  const artifactWrites: any[] = [];
  const comments: any[] = [];
  const relations: any[] = [];
  const faults = { dropArtifact: false, dropAfterPreparation: false, dropAcceptedTurn: false, rejectBeforeTurn: false, linearDown: false, dropActivity: false, snapshotDown: false, deferStop: false, deferResponses: false, snapshotDenied: false, replayFallback: false, rejectAnswer: false, mergeChildPageSize: 100, failMergedIssueId: "", rateLimitIssueReads: false, emptySkillRefreshes: 0 };
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
      linearQueries.push(query);
      if (query.includes("BridgeIssue") && faults.rateLimitIssueReads) {
        res.statusCode = 400;
        res.end(JSON.stringify({ errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] })); return;
      }
      if (query.includes("BridgeIssue") && heldIssueRead && --heldIssueRead.remaining === 0) {
        const held = heldIssueRead; heldIssueRead = undefined;
        held.entered(); await held.wait;
      }
      if (query.includes("BridgeCurrentSession")) {
        res.end(JSON.stringify({ data: { viewer: { id: "app" }, issue: { agentSessions: { nodes: [...linearSessions.values()].filter(s => s.issueId === variables.id), pageInfo: { hasNextPage: false } } } } })); return;
      }
      if (query.includes("BridgeDeliverySessions")) {
        res.end(JSON.stringify({ data: { issue: { agentSessions: { nodes: [...linearSessions.values()].filter(s => s.issueId === variables.id).map(s => ({ id: s.id, archivedAt: archivedSessions.has(s.id) ? "2026-09-16T16:42:05Z" : null })), pageInfo: { hasNextPage: false } } } } })); return;
      }
      if (/mutation BridgeArtifact/.test(query)) {
        artifactWrites.push({ query, variables });
        const input = variables.input;
        if (query.includes("BridgeArtifactUpdate")) issueOverrides[variables.id] = { ...issueOverrides[variables.id], ...input };
        if (query.includes("BridgeArtifactCreate")) issueOverrides[input.id] = { ...input, parent: { id: input.parentId }, state: { type: "unstarted" }, delegate: null };
        if (query.includes("BridgeArtifactCommentCreate")) { if (!comments.some(c => c.id === input.id)) comments.push(input); }
        if (query.includes("BridgeArtifactRelationDelete")) { const index = relations.findIndex(r => r.id === variables.id); if (index >= 0) relations.splice(index, 1); }
        else if (query.includes("BridgeArtifactRelation")) { if (!relations.some(r => r.id === input.id)) relations.push(input); }
        if (faults.dropArtifact) { faults.dropArtifact = false; res.destroy(); return; }
        res.end(JSON.stringify({ data: { commentCreate: { success: true } } })); return;
      }
      if (query.includes("BridgeArtifactIssue")) {
        res.end(JSON.stringify({ data: { issues: { nodes: issueOverrides[variables.id] ? [{ id: variables.id, ...issueOverrides[variables.id] }] : [] } } })); return;
      }
      if (query.includes("BridgeArtifactRelations")) {
        res.end(JSON.stringify({ data: { issue: { inverseRelations: { pageInfo: { hasNextPage: false }, nodes: relations.filter(r => r.relatedIssueId === variables.id).map(r => ({ ...r, issue: { id: r.issueId } })) } } } })); return;
      }
      if (query.includes("BridgeArtifactComment")) {
        res.end(JSON.stringify({ data: { issue: { comments: { nodes: comments.filter(c => c.id === variables.commentId) } } } })); return;
      }
      if (query.includes("BridgeReviewStatus")) {
        res.end(JSON.stringify({ data: { team: { states: { nodes: [...statusNodes, { id: "uat", name: "Ready for UAT" }, { id: "implementation", name: "Ready for implementation" }, { id: "done", name: "Done" }] } } } })); return;
      }
      if (query.includes("BridgeMergeChildren")) {
        const children = Object.entries(issueOverrides).filter(([, child]) => child?.parent?.id === variables.id).map(([id]) => ({ id }));
        const start = Number(variables.after ?? 0);
        const end = Math.min(start + faults.mergeChildPageSize, children.length);
        res.end(JSON.stringify({ data: { issue: { children: { nodes: children.slice(start, end), pageInfo: { hasNextPage: end < children.length, endCursor: end < children.length ? String(end) : null } } } } })); return;
      }
      if (query.includes("BridgeReviewHandoff")) {
        const input = variables.input;
        issueOverrides[variables.id] = { ...issueOverrides[variables.id], state: { id: input.stateId, name: input.stateId === "uat" ? "Ready for UAT" : "Ready for implementation", team: { id: "team-1" }, type: "started" }, ...(Object.hasOwn(input, "delegateId") ? { delegate: null } : {}) };
        res.end(JSON.stringify({ data: { issueUpdate: { success: true } } })); return;
      }
      if (query.includes("BridgeMergedIssueUpdate")) {
        if (faults.failMergedIssueId === variables.id) { faults.failMergedIssueId = ""; res.end(JSON.stringify({ data: { issueUpdate: { success: false } } })); return; }
        issueOverrides[variables.id] = { ...issueOverrides[variables.id], state: { id: "done", name: "Done", team: { id: "team-1" }, type: "completed" }, delegate: null };
        res.end(JSON.stringify({ data: { issueUpdate: { success: true } } })); return;
      }
      if (query.includes("AgentActivityCreate")) {
        if (faults.linearDown) { res.statusCode = 503; res.end('{}'); return; }
        if (archivedSessions.has(variables.input.agentSessionId) || rejectedSessions.has(variables.input.agentSessionId)) { res.end(JSON.stringify({ errors: [{ message: "Entity not found: AgentSession", path: ["agentActivityCreate"] }] })); return; }
        if (!activities.some(a => a.id === variables.input.id)) activities.push(variables.input);
        if (faults.dropActivity) { faults.dropActivity = false; res.destroy(); return; }
        res.end(JSON.stringify({ data: { agentActivityCreate: { success: true, agentActivity: { id: variables.input.id } } } }));
      } else if (query.includes("BridgeActivity")) {
        if (faults.linearDown) { res.statusCode = 503; res.end('{}'); return; }
        if (archivedSessions.has(variables.sessionId) || rejectedSessions.has(variables.sessionId)) { res.end(JSON.stringify({ errors: [{ message: "Entity not found: AgentSession", path: ["agentSession"] }] })); return; }
        res.end(JSON.stringify({ data: { agentSession: { activities: { nodes: activities.filter(a => a.id === variables.id).map(a => ({ id: a.id })) } } } }));
      } else if (query.includes("BridgeProjectConfig")) {
        res.end(JSON.stringify({ data: { project: { content: projectDocument.content ?? "Project prose\n\n```yaml\n" + stringify(projectConfig) + "```" } } }));
      } else if (query.includes("BridgeProjectTeams")) {
        res.end(JSON.stringify({ data: { project: { teams: { nodes: [{ id: "team-1", key: "NOR" }], pageInfo: { hasNextPage: false } } } } }));
      } else if (query.includes("BridgeTeamStatuses")) {
        res.end(JSON.stringify({ data: { team: { states: { nodes: statusNodes, pageInfo: { hasNextPage: false } } } } }));      } else {
        reads.push(variables);
        res.end(JSON.stringify({ data: { viewer: { id: "app" }, issue: { state: { id: "implement", name: "implement", description: "t3code: implement", team: { id: "team-1" }, type: "started" }, delegate: { id: "app" }, parent: null, id: variables.id, identifier: variables.id === "issue-1" ? "NOR-1" : `NOR-${variables.id}`, title: "Make a change", description: "Use https://example.org/design", url: "https://linear.app/test/issue/NOR-1", project: { id: "project-1", name: "Test project" }, team: { id: "team-1" }, children: { nodes: Object.entries(issueOverrides).filter(([, child]) => child?.parent?.id === variables.id).map(([id, child]) => ({ id, ...child })), pageInfo: { hasNextPage: false } }, comments: { nodes: [], pageInfo: { hasNextPage: false } }, attachments: { nodes: [], pageInfo: { hasNextPage: false } }, relations: { nodes: [], pageInfo: { hasNextPage: false } }, inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } }, ...issueOverrides[variables.id], ...(variables.after ? issueOverrides[variables.id + ":" + variables.after] : {}) } } }));
      }
    } else {
      assert.equal(req.headers.authorization, "Bearer t3-secret");
      if (req.url === "/api/auth/websocket-ticket") { res.end(JSON.stringify({ ticket: "test-ticket", expiresAt: new Date(Date.now() + 30000).toISOString() })); }
      else if (req.url === "/api/orchestration/dispatch") {
        const command = JSON.parse(raw);
        if (faults.rejectAnswer && ["thread.user-input.respond", "thread.approval.respond"].includes(command.type)) { faults.rejectAnswer = false; res.statusCode = 400; res.end("{}"); return; }
        if (faults.rejectBeforeTurn && command.type === "thread.turn.start") { faults.rejectBeforeTurn = false; res.statusCode = 503; res.end('{}'); return; }
        if (!commands.some(c => c.commandId === command.commandId)) {
          commands.push(command);
          sequence++;
          if (command.type === "thread.create") threads.set(command.threadId, { id: command.threadId, projectId: command.projectId, branch: command.branch, worktreePath: command.worktreePath, messages: [], activities: [], latestTurn: null, session: null });
          if (command.type === "thread.turn.start") {
            const thread = threads.get(command.threadId);
            if (command.bootstrap?.prepareWorktree && req.headers["x-bootstrap-rpc"] === "true") {
              const prep = command.bootstrap.prepareWorktree;
              const worktree = path.join(root, "t3-worktrees", command.threadId);
              execFileSync("git", ["-C", prep.projectCwd, "worktree", "add", "-b", prep.branch, worktree, prep.baseBranch]);
              thread.worktreePath = worktree; thread.branch = prep.branch;
              if (faults.dropAfterPreparation) { faults.dropAfterPreparation = false; commands.pop(); res.destroy(); return; }
            }
            thread.messages.push({ id: command.message.messageId, role: "user", text: command.message.text, turnId: command.message.messageId });
            thread.latestTurn = { turnId: command.message.messageId, state: "running" };
            thread.session = { status: "running", activeTurnId: command.message.messageId, lastError: null };
          }
          if (["thread.approval.respond", "thread.user-input.respond"].includes(command.type) && !faults.deferResponses) {
            const thread = threads.get(command.threadId);
            thread.activities.push({ id: command.commandId + "-resolved", kind: command.type === "thread.approval.respond" ? "approval.resolved" : "user-input.resolved", tone: "info", summary: "Request resolved", turnId: thread.latestTurn?.turnId ?? null, payload: { requestId: command.requestId } });
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
        if (faults.snapshotDenied) { res.statusCode = 403; res.end("{}"); return; }
        if (faults.snapshotDown) { res.statusCode = 503; res.end("{}"); return; }
        const thread = threads.get(decodeURIComponent(req.url.split("/").at(-1)!));
        if (!thread) { res.statusCode = 404; res.end('{}'); }
        else res.end(JSON.stringify({ snapshotSequence: Math.max(sequence, ...events.map(e => e.sequence)), thread }));
      } else if (req.url === "/api/orchestration/snapshot") {
        res.end(JSON.stringify({ snapshotSequence: sequence, projects, threads: [...threads.values()] }));
      } else { res.statusCode = 404; res.end('{}'); }
    }
  });
  const sockets = new WebSocketServer({ server: external, path: "/ws" });
  sockets.on("connection", (socket, request) => {
    assert.match(request.url!, /wsTicket=test-ticket/);
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      if (message._tag !== "Request") return;
      if (message.tag === "orchestration.dispatchCommand") {
        void fetch(externalUrl + "/api/orchestration/dispatch", { method: "POST", headers: { authorization: "Bearer t3-secret", "x-bootstrap-rpc": "true" }, body: JSON.stringify(message.payload) }).then(async response => {
          if (response.status >= 500) { socket.close(); return; }
          socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: response.ok ? { _tag: "Success", value: await response.json() } : { _tag: "Failure", cause: { _tag: "Fail" } } }));
        }).catch(() => socket.close()); return;
      }
      if (message.tag === "server.refreshProviders") {
        const discoveredSkills = faults.emptySkillRefreshes > 0 ? [] : skills;
        if (faults.emptySkillRefreshes > 0) faults.emptySkillRefreshes--;
        socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: { providers: providers.map(p => ({ ...p, workspaceSnapshots: [{ cwd: message.payload.cwd, skills: discoveredSkills }] })) } } })); return;
      }
      if (message.tag === "server.getSettings" || message.tag === "server.getConfig") {
        socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: message.tag === "server.getSettings" ? settings : { providers } } })); return;
      }
      if (message.tag === "vcs.listRefs" || message.tag === "vcs.refreshStatus") {
        let name: string | null = null;
        try { name = execFileSync("git", ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace("refs/remotes/origin/", ""); } catch {}
        const value = message.tag === "vcs.listRefs" ? { isRepo: true, refs: name ? [{ name, isDefault: true }] : [], nextCursor: null } : { isRepo: true, refName: execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim() };
        socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value } })); return;
      }
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
    pullRequests: { find: async (_route: unknown, branch: string): Promise<PullRequest | null> => ({ ...pr, headRefName: branch }) },
    githubReviews: { verify: async (event: any) => ({ url: event.pull_request.html_url, branch: event.pull_request.head.ref, head: event.review.commit_id, open: true, checksPassing: true }),
      verifyMerge: async (event: any) => ({ url: event.pull_request.html_url, branch: event.pull_request.head.ref, merged: true }) },
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
    const sessionEvent = payload as { agentSession?: { id: string; issue: { id: string } } };
    if (sessionEvent.agentSession && !linearSessions.has(sessionEvent.agentSession.id)) linearSessions.set(sessionEvent.agentSession.id, { id: sessionEvent.agentSession.id, issueId: sessionEvent.agentSession.issue.id, createdAt: new Date(Date.UTC(2026, 0, 1) + linearSessions.size * 1000).toISOString(), appUser: { id: "app" } });
    const body = JSON.stringify({ type: "AgentSessionEvent", webhookTimestamp: Date.now(), ...payload });
    return fetch(url + "/linear/webhook", { method: "POST", headers: { "content-type": "application/json", "linear-signature": signature ? createHmac("sha256", "webhook-secret").update(body).digest("hex") : "bad" }, body });
  };
  const sendGithub = async (payload: object, signature = true, deliveryId = "11111111-1111-4111-8111-111111111111", eventType = "pull_request_review") => {
    const body = JSON.stringify(payload);
    return fetch(url + "/github/webhook", { method: "POST", headers: { "content-type": "application/json", "x-github-event": eventType, "x-github-delivery": deliveryId, "x-hub-signature-256": signature ? `sha256=${createHmac("sha256", "github-webhook-secret").update(body).digest("hex")}` : "sha256=bad" }, body });
  };
  return { linearSessions, archivedSessions, rejectedSessions, artifactWrites, comments, relations, skills, projects, settings, providers, projectConfig, projectDocument, statusNodes, commands, activities, threads, events, attachmentRequests, repo, root, send, sendGithub, issueOverrides, reads, linearQueries, pr, faults, options,
    holdIssueRead: (remaining: number) => {
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      heldIssueRead = { remaining, entered, wait };
      return { reached, release };
    },
    tick: async (n = 8) => { for (let i = 0; i < n; i++) await bridge.tick(); },
    restart: async () => { await close(app); await bridge.close(); bridge = new Bridge(options); app = createServer(createApp(bridge)); url = await listen(app); },
  };
}
const delegation = (session = "session-1") => ({ action: "created", organizationId: "workspace-1", agentSession: { id: session, issue: { id: session === "session-1" ? "issue-1" : `issue-${session}` } } });

test("a temporary empty skill refresh does not pause the next workflow stage", async t => {
  const f = await fixture(t);
  f.faults.emptySkillRefreshes = 1;
  await f.send(delegation()); await f.tick();
  assert.ok(f.commands.some(command => command.type === "thread.turn.start"));
  assert.equal(f.activities.some(activity => activity.content.type === "error" && /Workflow skill/.test(activity.content.body)), false);
});

test("a paused stage resumes when its required T3Code skill becomes available", async t => {
  const f = await fixture(t);
  f.faults.emptySkillRefreshes = 3;
  await f.send(delegation());
  for (let i = 0; i < 8 && !f.activities.some(activity => activity.content.type === "error" && /Workflow skill/.test(activity.content.body)); i++) await f.tick(1);
  assert.equal(f.commands.some(command => command.type === "thread.turn.start"), false);
  assert.ok(f.activities.some(activity => activity.content.type === "error" && /Workflow skill/.test(activity.content.body)));
  await f.tick();
  assert.ok(f.commands.some(command => command.type === "thread.turn.start"));
});

test("an active turn reuses its verified Linear gate between webhook changes", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  assert.ok(f.commands.some(c => c.type === "thread.turn.start"));
  const gateReads = () => f.linearQueries.filter(query => query.includes("BridgeCurrentSession") || query.includes("BridgeIssue")).length;
  const before = gateReads();
  await f.tick(5);
  assert.equal(gateReads(), before);
  await f.send({ type: "Issue", action: "update", organizationId: "workspace-1",
    data: { id: "issue-1", updatedAt: "2026-09-25T20:00:00Z" }, updatedFrom: { stateId: "previous" } });
  await f.tick(1);
  assert.ok(gateReads() > before);
});

test("a Linear rate limit backs off preflight instead of retrying every tick", async t => {
  const f = await fixture(t);
  f.faults.rateLimitIssueReads = true;
  await f.send(delegation()); await f.tick(5);
  assert.equal(f.linearQueries.filter(query => query.includes("BridgeIssue")).length, 1);
});

test("signed CodeRabbit review moves a current PR back to implementation once", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  f.issueOverrides["issue-1"] = { state: { id: "review", name: "Ready for review", team: { id: "team-1" }, type: "started" } };
  const event = { action: "submitted", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, head: { ref: branch } }, review: { id: 101, state: "changes_requested", commit_id: "a".repeat(40), html_url: f.pr.url + "#pullrequestreview-101", body: "Fix the race", user: { login: "coderabbitai[bot]" } } };
  assert.equal((await f.sendGithub(event, false)).status, 401);
  assert.equal((await f.sendGithub(event)).status, 200);
  await f.tick();
  assert.equal(f.issueOverrides["issue-1"].state.name, "Ready for implementation");
  assert.equal(f.comments.length, 1);
  await f.sendGithub(event); await f.tick();
  assert.equal(f.comments.length, 1);
});

test("CodeRabbit approval advances to UAT only for passing checks and clears delegation", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  f.issueOverrides["issue-1"] = { state: { id: "review", name: "Ready for review", team: { id: "team-1" }, type: "started" } };
  const event = { action: "submitted", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, head: { ref: branch } }, review: { id: 102, state: "approved", commit_id: "b".repeat(40), html_url: f.pr.url + "#pullrequestreview-102", body: "Looks good", user: { login: "coderabbitai[bot]" } } };
  f.options.githubReviews.verify = async () => ({ url: f.pr.url, branch, head: "b".repeat(40), open: true, checksPassing: false });
  await f.sendGithub(event, true, "22222222-2222-4222-8222-222222222222"); await f.tick();
  assert.equal(f.issueOverrides["issue-1"].state.name, "Ready for review");
  f.options.githubReviews.verify = async () => ({ url: f.pr.url, branch, head: "b".repeat(40), open: true, checksPassing: true });
  await f.tick();
  assert.equal(f.issueOverrides["issue-1"].state.name, "Ready for UAT");
  assert.equal(f.issueOverrides["issue-1"].delegate, null);
});

test("CodeRabbit review for an older PR head cannot change the Linear issue", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  f.issueOverrides["issue-1"] = { state: { id: "review", name: "Ready for review", team: { id: "team-1" }, type: "started" } };
  const event = { action: "submitted", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, head: { ref: branch } }, review: { id: 103, state: "approved", commit_id: "c".repeat(40), html_url: f.pr.url, user: { login: "coderabbitai[bot]" } } };
  f.options.githubReviews.verify = async () => ({ url: f.pr.url, branch, head: "d".repeat(40), open: true, checksPassing: true });
  await f.sendGithub(event, true, "33333333-3333-4333-8333-333333333333"); await f.tick();
  assert.equal(f.issueOverrides["issue-1"].state.name, "Ready for review");
  assert.equal(f.comments.length, 0);
});

test("merged PR marks its saved Linear issue Done after the agent session closes", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  finish(f); await f.tick();
  f.issueOverrides["issue-1"] = { state: { id: "uat", name: "Ready for UAT", team: { id: "team-1" }, type: "started" }, delegate: null };
  f.pr.state = "MERGED";
  await f.tick();
  const event = { action: "closed", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, merged: true, head: { ref: branch } } };
  assert.equal((await f.sendGithub(event, false, "44444444-4444-4444-8444-444444444444", "pull_request")).status, 401);
  const response = await f.sendGithub(event, true, "44444444-4444-4444-8444-444444444444", "pull_request");
  assert.deepEqual(await response.json(), { ok: true, accepted: true });
  await f.tick();
  assert.equal(f.issueOverrides["issue-1"].state.name, "Done");
  assert.equal(f.issueOverrides["issue-1"].delegate, null);
  await f.sendGithub(event, true, "44444444-4444-4444-8444-444444444444", "pull_request"); await f.tick();
  assert.equal(f.issueOverrides["issue-1"].state.name, "Done");
});

test("merged PR completes paginated child issues before the parent and retries a partial failure", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  f.issueOverrides["issue-1"] = { state: { id: "uat", name: "Ready for UAT", team: { id: "team-1" }, type: "started" }, delegate: null };
  for (const id of ["child-1", "child-2"]) f.issueOverrides[id] = { parent: { id: "issue-1" }, state: { id: "uat", name: "Ready for UAT", team: { id: "team-1" }, type: "started" }, delegate: { id: "app" } };
  f.faults.mergeChildPageSize = 1;
  f.faults.failMergedIssueId = "child-2";
  f.pr.state = "MERGED";
  const event = { action: "closed", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, merged: true, head: { ref: branch } } };
  const response = await f.sendGithub(event, true, "77777777-7777-4777-8777-777777777777", "pull_request");
  assert.deepEqual(await response.json(), { ok: true, accepted: true });
  await f.tick(1);
  assert.equal(f.issueOverrides["child-1"].state.name, "Done");
  assert.equal(f.issueOverrides["child-2"].state.name, "Ready for UAT");
  assert.equal(f.issueOverrides["issue-1"].state.name, "Ready for UAT");
  await f.tick();
  assert.equal(f.issueOverrides["child-2"].state.name, "Done");
  assert.equal(f.issueOverrides["child-2"].delegate, null);
  assert.equal(f.issueOverrides["issue-1"].state.name, "Done");
});

test("merged PR still completes children when the parent is already Done", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  f.issueOverrides["issue-1"] = { state: { id: "done", name: "Done", team: { id: "team-1" }, type: "completed" }, delegate: null };
  f.issueOverrides["child-1"] = { parent: { id: "issue-1" }, state: { id: "uat", name: "Ready for UAT", team: { id: "team-1" }, type: "started" }, delegate: null };
  f.pr.state = "MERGED";
  const event = { action: "closed", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, merged: true, head: { ref: branch } } };
  await f.sendGithub(event, true, "88888888-8888-4888-8888-888888888888", "pull_request"); await f.tick();
  assert.equal(f.issueOverrides["child-1"].state.name, "Done");
  assert.equal(f.issueOverrides["issue-1"].state.name, "Done");
});

test("closed but unmerged PR does not mark its Linear issue Done", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  const event = { action: "closed", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, merged: false, head: { ref: branch } } };
  const response = await f.sendGithub(event, true, "55555555-5555-4555-8555-555555555555", "pull_request");
  assert.deepEqual(await response.json(), { ok: true, accepted: false });
  await f.tick();
  assert.equal(f.issueOverrides["issue-1"]?.state?.name, undefined);
});

test("merged PR handoff waits for GitHub verification and survives a bridge restart", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const branch = f.commands.find(c => c.type === "thread.create")?.branch;
  assert.ok(branch);
  f.pr.state = "MERGED";
  const event = { action: "closed", repository: { full_name: "test/repo" }, pull_request: { number: 42, html_url: f.pr.url, merged: true, head: { ref: branch } } };
  f.options.githubReviews.verifyMerge = async () => ({ url: f.pr.url, branch, merged: false });
  await f.sendGithub(event, true, "66666666-6666-4666-8666-666666666666", "pull_request"); await f.tick();
  assert.equal(f.issueOverrides["issue-1"]?.state?.name, undefined);
  await f.restart();
  f.options.githubReviews.verifyMerge = async () => ({ url: f.pr.url, branch, merged: true });
  await f.tick();
  assert.equal(f.issueOverrides["issue-1"].state.name, "Done");
});

test("archived Linear sessions retain undelivered updates without blocking live sessions", async t => {
  const f = await fixture(t);
  f.options.concurrency = 2;
  f.archivedSessions.add("session-1");
  await f.send(delegation());
  await f.send(delegation("session-2"));
  await f.tick(4);
  assert.ok(f.activities.some(activity => activity.agentSessionId === "session-2"));
  const db = new DatabaseSync(path.join(f.root, "bridge.sqlite"), { readOnly: true });
  const state = JSON.parse(String(db.prepare("SELECT body FROM bridge_state WHERE id=1").get()!.body));
  db.close();
  assert.ok(state.undeliverable.some((entry: { sessionId: string }) => entry.sessionId === "session-1"));
  assert.ok(!state.outbox.some((entry: { sessionId: string }) => entry.sessionId === "session-1"));
});

test("unverified delivery failures retain order and allow other sessions to deliver", async t => {
  const f = await fixture(t);
  f.options.concurrency = 2;
  f.rejectedSessions.add("session-1");
  await f.send(delegation());
  await f.send(delegation("session-2"));
  await f.tick(4);
  assert.ok(f.activities.some(activity => activity.agentSessionId === "session-2"));
  const db = new DatabaseSync(path.join(f.root, "bridge.sqlite"), { readOnly: true });
  const state = JSON.parse(String(db.prepare("SELECT body FROM bridge_state WHERE id=1").get()!.body));
  db.close();
  assert.ok(state.outbox.some((entry: { sessionId: string }) => entry.sessionId === "session-1"));
  assert.ok(!state.undeliverable?.some((entry: { sessionId: string }) => entry.sessionId === "session-1"));
});

test("signed delegation creates one isolated configured T3Code turn and reports intake", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { project: { id: "project-1", name: "ReportXL" }, title: "Organisation lifecycle and workspace settings", state: { id: "implement", name: "Ready for grilling", description: "t3code: implement", team: { id: "team-1" }, type: "started" } };
  assert.equal((await f.send(delegation(), false)).status, 401);
  assert.equal((await f.send({ ...delegation(), webhookTimestamp: 1 })).status, 401);
  assert.equal((await f.send(delegation())).status, 200);
  await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  assert.equal(f.commands.find(c => c.type === "thread.create").title, "ReportXL: Organisation lifecycle and workspace settings - Ready for grilling");
  const start = f.commands.find(c => c.type === "thread.turn.start");
  assert.ok(start);
  assert.deepEqual(start.modelSelection, { instanceId: "codex", model: "test-model" });
  assert.equal(start.runtimeMode, "full-access");
  assert.match(start.message.text, /Organisation lifecycle and workspace settings/);
  assert.match(start.message.text, /https:\/\/example.org\/design/);
  const thread = [...f.threads.values()][0];
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
  assert.ok(f.activities.some(a => /new Linear ticket/i.test(a.content.body)));
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
  assert.equal(new Set([...f.threads.values()].map(c => c.worktreePath)).size, 2);
  assert.equal(new Set(creates.map(c => c.branch)).size, 2);
  finish(f); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 3);
});

test("issues without projects cannot start work and issue text cannot override routing", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { project: null, description: "Use repository /tmp/evil and project-1 instead" };
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
  assert.ok(f.activities.some(a => /no Linear project/.test(a.content.body)));
});

test("required available context does not make unrelated missing material a prerequisite", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { description: "You must read the issue description before implementing. Existing comments are optional.", comments: null };
  await f.send(delegation()); await f.tick();
  const start = f.commands.find(c => c.type === "thread.turn.start");
  assert.ok(start);
  assert.match(start.message.text, /comments are optional/);
  assert.match(start.message.text, /#comments/);
  assert.match(start.message.text, /unavailable/);
});

test("missing prerequisites reach T3Code for clarification and explicit answers preserve queued work", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { description: "You must read the existing comments before implementing.", comments: null };
  await f.send(delegation()); await f.tick();
  const start = f.commands.find(c => c.type === "thread.turn.start");
  assert.ok(start);
  assert.match(start.message.text, /required material is unavailable, pause.*before stage execution/);
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "prerequisite", kind: "user-input.requested", tone: "info", summary: "Comments are unavailable; are they required?", turnId: thread.latestTurn.turnId, payload: { requestId: "missing-comments", questions: [{ id: "required", question: "Are comments required?" }] } });
  await f.send(followup("later-work", "Then update the README"));
  await f.tick();
  await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  await f.send(followup("waiver", 'answer missing-comments {"required":"Comments are optional; continue with the available description."}'));
  await f.tick();
  assert.match(f.commands.find(c => c.type === "thread.user-input.respond").answers.required, /optional/);
  finish(f); await f.tick();
  assert.match(f.commands.filter(c => c.type === "thread.turn.start")[1].message.text, /Then update the README/);
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
  assert.ok(f.activities.some(a => a.content.type === "elicitation" && /Where is the required design/.test(a.content.body)));
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
  assert.ok(f.activities.some(a => a.content.type === "elicitation" && /Choose/.test(a.content.body)));
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
  await f.send(followup("rejected", "invalid")); await f.tick();
  assert.ok(f.activities.some(a => /rejected your answer/.test(a.content.body)));
  await f.send(followup("corrected", "valid")); await f.tick();
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

test("closed PR cleanup preserves ignored files across restart", async t => {
  const f = await fixture(t);
  const origin = path.join(f.root, "origin.git");
  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["-C", f.repo, "remote", "add", "origin", origin]);
  await writeFile(path.join(f.repo, ".gitignore"), "private.env\n");
  execFileSync("git", ["-C", f.repo, "add", ".gitignore"]);
  execFileSync("git", ["-C", f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Ignore local config"]);
  execFileSync("git", ["-C", f.repo, "push", "origin", "main"]);
  await f.send(delegation()); await f.tick(); finish(f); await f.tick();
  const thread = [...f.threads.values()][0];
  const file = path.join(thread.worktreePath, "private.env");
  await writeFile(file, "local configuration");
  f.pr.state = "CLOSED"; await f.tick(); await f.restart(); await f.tick();
  assert.equal(await readFile(file, "utf8"), "local configuration");
  assert.ok(f.activities.some(a => /preserved.*ignored/i.test(a.content.body)));
});

test("provider response failures retain correlation until resolution across restart", async t => {
  const f = await fixture(t);
  f.faults.deferResponses = true;
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  for (const [kind, id, body, commandType] of [
    ["user-input", "question", 'answer question {"choice":"staging"}', "thread.user-input.respond"],
    ["approval", "approval", "approve approval", "thread.approval.respond"],
  ]) {
    thread.activities.push({ id: id + "-requested", kind: kind + ".requested", tone: "info", summary: "Decision needed", turnId: thread.latestTurn.turnId, payload: { requestId: id, questions: [{ id: "choice", question: "Which environment?" }] } });
    await f.tick(); await f.send(followup(id + "-answer", body)); await f.tick();
    await f.restart(); await f.send(followup(id + "-duplicate", body)); await f.tick();
    assert.equal(f.commands.filter(c => c.type === commandType).length, 1);
    thread.activities.push({ id: id + "-failed", kind: "provider." + kind + ".respond.failed", tone: "error", summary: "Provider response failed", turnId: null, payload: { requestId: id } });
    await f.tick(); await f.restart();
    assert.ok(f.activities.some(a => a.content.type === "elicitation" && /failed|could not accept/i.test(a.content.body) && (kind === "user-input" || a.content.body.includes(id))));
    await f.send(followup(id + "-retry", body)); await f.tick();
    assert.equal(f.commands.filter(c => c.type === commandType).length, 2);
    thread.activities.push({ id: id + "-resolved", kind: kind + ".resolved", tone: "info", summary: "Resolved", turnId: thread.latestTurn.turnId, payload: { requestId: id } });
    await f.tick();
  }
  await f.send(followup("next", "Next task")); finish(f); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
});

test("provider stop failure is reported and explicitly retried without releasing queued work", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  f.faults.deferStop = true;
  await f.send(followup("stop-attempt", "stop")); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "stop-failed", kind: "provider.session.stop.failed", tone: "error", summary: "Provider stop failed", turnId: null, payload: {} });
  await f.send(followup("queued-after-stop", "Later task")); await f.restart(); await f.tick();
  assert.ok(f.activities.some(a => a.content.type === "error" && /stop.*failed/i.test(a.content.body) && /cancel/i.test(a.content.body)));
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  f.faults.deferStop = false;
  await f.send(followup("stop-retry", "cancel")); await f.tick();
  assert.equal(thread.session.status, "stopped");
  assert.equal(f.commands.filter(c => c.type === "thread.session.stop").length, 2);
  assert.ok(f.activities.some(a => /Pending prompts cleared/.test(a.content.body)));
});

test("completed paused provider releases capacity without resuming its queue", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  await f.send(followup("preserved", "Keep this queued"));
  f.faults.snapshotDenied = true; await f.tick();
  await f.send(delegation("session-2"));
  finish(f); f.faults.snapshotDenied = false;
  await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 2);
  const firstId = f.commands.find(c => c.type === "thread.create").threadId;
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start" && c.threadId === firstId).length, 1);
});

test("large-gap unresolved accepted answers allow explicit recovery without automatic resubmission", async t => {
  const f = await fixture(t); f.faults.deferResponses = true;
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "pinned", kind: "approval.requested", tone: "info", summary: "Approve?", turnId: thread.latestTurn.turnId, payload: { requestId: "pinned-approval" } });
  await f.tick(); await f.send(followup("first-answer", "approve pinned-approval")); await f.tick();
  f.faults.replayFallback = true;
  await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.approval.respond").length, 1);
  assert.ok(f.activities.some(a => a.content.type === "elicitation" && /outcome.*unknown/i.test(a.content.body)));
  await f.send(followup("unrelated-answer", "yes")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.approval.respond").length, 1);
  f.faults.rejectAnswer = true;
  await f.send(followup("explicit-recovery", "approve pinned-approval")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.approval.respond").length, 1);
  await f.restart();
  await f.send(followup("corrected-recovery", "approve pinned-approval")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.approval.respond").length, 2);
});

test("persistent denied snapshots do not repeat pause notifications", async t => {
  const f = await fixture(t); await f.send(delegation()); await f.tick();
  f.faults.snapshotDenied = true; await f.tick();
  const count = f.activities.filter(a => a.content.type === "error").length;
  await f.restart(); await f.tick();
  assert.equal(f.activities.filter(a => a.content.type === "error").length, count);
});

test("cancelling before execution reports that no active turn remained", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.send(followup("cancel-before-start", "cancel")); await f.tick();
  assert.equal(f.commands.length, 0);
  assert.ok(f.activities.some(a => /no active.*turn/i.test(a.content.body)));
});

 test("routing selects an exact active T3Code title, independently of bridge UUID routes", async t => {
  const f = await fixture(t);
  f.projects[0].id = "resolved-project";
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.find(c => c.type === "thread.create")?.projectId, "resolved-project");
});

test("null project model inherits T3Code environment settings", async t => {
  const f = await fixture(t); f.projects[0].defaultModelSelection = null;
  await f.send(delegation()); await f.tick();
  assert.deepEqual(f.commands.find(c => c.type === "thread.turn.start")?.modelSelection, { instanceId: "codex", model: "inherited-model" });
});

test("tickets use readable isolated branches even when T3Code prefers the current checkout", async t => {
  const f = await fixture(t); f.projects[0].defaultThreadEnvMode = "local";
  f.issueOverrides["issue-1"] = { identifier: "NOR-228", title: "Test issue to test T3Code connectivity" };
  await writeFile(path.join(f.repo, "keep.txt"), "existing files");
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  assert.equal(thread.branch, "t3code/nor-228-test-issue-to-test-t3code-connectivity");
  assert.ok(thread.worktreePath); assert.notEqual(thread.worktreePath, f.repo);
  assert.equal(execFileSync("git", ["-C", f.repo, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
  assert.equal(await readFile(path.join(f.repo, "keep.txt"), "utf8"), "existing files");
});

test("new worktree uses T3Code bootstrap from repository default and inherits start-from-origin", async t => {
  const f = await fixture(t); f.settings.newWorktreesStartFromOrigin = true;
  execFileSync("git", ["-C", f.repo, "branch", "default"]);
  execFileSync("git", ["-C", f.repo, "update-ref", "refs/remotes/origin/default", "HEAD"]);
  execFileSync("git", ["-C", f.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/default"]);
  await f.send(delegation()); await f.tick();
  const turn = f.commands.find(c => c.type === "thread.turn.start");
  assert.ok([...f.threads.values()][0]?.worktreePath);
  assert.deepEqual(turn?.bootstrap, { prepareWorktree: { projectCwd: f.repo, baseBranch: "default", branch: [...f.threads.values()][0].branch, startFromOrigin: true }, runSetupScript: true });
});

test("routing errors pause until correction and explicit resume; duplicate delivery never retries", async t => {
  const cases = ["missing block", "multiple blocks", "unknown", "case mismatch", "deleted", "duplicate"];
  for (const scenario of cases) await t.test(scenario, async t => {
    const f = await fixture(t);
    const originalProjects = structuredClone(f.projects);
    if (scenario === "missing block") f.projectDocument.content = "No configuration";
    if (scenario === "multiple blocks") f.projectDocument.content = ("```yaml\n" + stringify(f.projectConfig) + "```\n").repeat(2);
    if (scenario === "unknown") f.projectConfig.t3code.project = "Unknown";
    if (scenario === "case mismatch") f.projectConfig.t3code.project = "test project";
    if (scenario === "deleted") f.projects[0]!.deletedAt = new Date().toISOString();
    if (scenario === "duplicate") f.projects.push({ ...f.projects[0]!, id: "duplicate", workspaceRoot: "/another/checkout" });
    await f.send(delegation()); await f.tick();
    assert.equal(f.commands.length, 0);
    assert.ok(f.activities.some(a => a.content.type === "error" && /resume/.test(a.content.body)));
    if (scenario === "duplicate") { const message = f.activities.map(a => a.content.body).join("\n"); assert.ok(message.includes(f.repo)); assert.match(message, /\/another\/checkout/); }
    f.projectDocument.content = undefined; f.projectConfig.t3code.project = "Test project"; f.projects.splice(0, f.projects.length, ...originalProjects);
    await f.restart(); await f.send(delegation()); await f.tick(); assert.equal(f.commands.length, 0);
    await f.send(followup("corrected", "resume")); await f.tick();
    assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  });
});

test("unavailable effective settings pause and can be corrected before the first execution", async t => {
  for (const scenario of ["missing model", "unavailable provider", "uninstalled provider", "unknown model"]) await t.test(scenario, async t => {
    const f = await fixture(t); f.projects[0].defaultModelSelection = null;
    if (scenario === "missing model") f.settings.defaultModelSelection = null;
    if (scenario === "unavailable provider") f.providers[0]!.availability = "unavailable";
    if (scenario === "uninstalled provider") f.providers[0]!.installed = false;
    if (scenario === "unknown model") f.settings.defaultModelSelection.model = "unknown";
    await f.send(delegation()); await f.tick(); assert.equal(f.commands.length, 0);
    assert.ok(f.activities.some(a => /No available effective/.test(a.content.body)));
    f.settings.defaultModelSelection = { instanceId: "codex", model: "inherited-model" }; f.providers[0]!.installed = true; f.providers[0]!.availability = "available";
    await f.send(followup("corrected", "resume")); await f.tick();
    assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  });
});

test("ticket isolation overrides local preferences at every settings level", async t => {
  for (const scenario of ["project", "repository", "environment"]) await t.test(scenario, async t => {
    const f = await fixture(t);
    f.projects[0].defaultThreadEnvMode = scenario === "project" ? "local" : null;
    f.settings.defaultThreadEnvMode = scenario === "environment" ? "local" : "worktree";
    if (scenario !== "environment") await writeFile(path.join(f.repo, "t3.json"), '{ // repository preference\n "defaultThreadEnvMode": "' + (scenario === "project" ? "worktree" : "local") + '",\n}');
    await f.send(delegation()); await f.tick();
    assert.ok([...f.threads.values()][0]?.worktreePath);
    assert.ok(f.commands.find(c => c.type === "thread.turn.start")?.bootstrap?.prepareWorktree);
  });
});

test("established sessions retain settings and identity while new sessions resolve renamed projects", async t => {
  const f = await fixture(t); await f.send(delegation()); await f.tick(); finish(f); await f.tick();
  const first = [...f.threads.values()][0]; const branch = first.branch, worktree = first.worktreePath;
  f.projects[0].title = "Renamed project"; f.projectConfig.t3code.project = "Renamed project";
  f.projects[0].defaultModelSelection = { instanceId: "codex", model: "inherited-model" };
  await f.restart(); await f.send(delegation()); await f.send(followup("feedback", "Adjust the result")); await f.tick();
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2); assert.equal(turns[1].modelSelection.model, "test-model"); assert.equal(turns[1].bootstrap, undefined);
  assert.equal(first.branch, branch); assert.equal(first.worktreePath, worktree);
  finish(f); await f.tick(); await f.send(delegation("new")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").at(-1).modelSelection.model, "inherited-model");
});

test("cancel immediately after worktree bootstrap retains its workspace for later work", async t => {
  const f = await fixture(t); await f.send(delegation()); await f.tick(2);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  await f.send(followup("cancel", "cancel")); await f.tick(); await f.restart();
  await f.send(followup("continue", "Continue the task")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  assert.equal(f.commands.filter(c => c.bootstrap?.prepareWorktree).length, 1);
});

test("folded project settings override stale snapshot values and a cleared effective model pauses", async t => {
  const f = await fixture(t); f.settings.projectSettingsFolded = true;
  f.settings.projectSettingsOverrides = { "t3-project": { defaultModelSelection: null, defaultThreadEnvMode: "local" } };
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
  f.settings.projectSettingsOverrides["t3-project"].defaultModelSelection = { instanceId: "codex", model: "inherited-model", options: { effort: "high" } };
  await f.send(followup("corrected", "resume")); await f.tick();
  const turn = f.commands.find(c => c.type === "thread.turn.start");
  assert.deepEqual(turn.modelSelection, { instanceId: "codex", model: "inherited-model", options: { effort: "high" } });
  assert.ok([...f.threads.values()][0].worktreePath);
});

test("disabled project provider settings inherit the enabled environment provider", async t => {
  const f = await fixture(t);
  f.projects[0].defaultModelSelection = { instanceId: "disabled", model: "other-model" };
  f.settings.providerInstances.disabled = { enabled: true, config: { enabled: false } };
  f.providers.push({ instanceId: "disabled", enabled: false, installed: true, availability: "available", models: [{ slug: "other-model" }] });
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.find(c => c.type === "thread.turn.start")?.modelSelection.instanceId, "codex");
});

test("different tickets can execute concurrently in separate worktrees", async t => {
  const f = await fixture(t); f.projects[0].defaultThreadEnvMode = "local"; f.options.concurrency = 2;
  await Promise.all([f.send(delegation("one")), f.send(delegation("two"))]); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  const threads = [...f.threads.values()];
  assert.notEqual(threads[0].branch, threads[1].branch);
  assert.notEqual(threads[0].worktreePath, threads[1].worktreePath);
});

test("worktree without a known default starts at the checked-out branch and can keep local history", async t => {
  const f = await fixture(t); f.settings.newWorktreesStartFromOrigin = false;
  execFileSync("git", ["-C", f.repo, "checkout", "-b", "topic"]);
  execFileSync("git", ["-C", f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Local topic"]);
  const head = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  await f.send(delegation()); await f.tick();
  const turn = f.commands.find(c => c.type === "thread.turn.start");
  assert.equal(turn.bootstrap.prepareWorktree.baseBranch, "topic"); assert.equal(turn.bootstrap.prepareWorktree.startFromOrigin, false);
  assert.equal(execFileSync("git", ["-C", [...f.threads.values()][0].worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }), head);
});

test("existing unowned ticket branches pause without creating a thread or replacing files", async t => {
  const f = await fixture(t);
  execFileSync("git", ["-C", f.repo, "branch", "t3code/nor-1-make-a-change"]);
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
  assert.ok(f.activities.some(a => /already exists without a saved ticket workspace/.test(a.content.body)));
});

test("uncertain bootstrap setup pauses after preparation until explicit repair and resume", async t => {
  const f = await fixture(t); f.faults.dropAfterPreparation = true;
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0]; assert.ok(thread.worktreePath);
  assert.equal(thread.messages.length, 0);
  assert.ok(f.activities.some(a => /setup.*unconfirmed/i.test(a.content.body)));
  await f.restart(); await f.send(delegation()); await f.tick(); assert.equal(thread.messages.length, 0);
  // Simulate the operator completing the interrupted setup before explicit retry.
  await writeFile(path.join(thread.worktreePath, "setup-ready"), "ready");
  await f.send(followup("repaired", "resume")); await f.tick();
  assert.equal(thread.messages.length, 1); assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  assert.equal((execFileSync("git", ["-C", f.repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).match(/^worktree /gm) ?? []).length, 2);
});

test("unavailable worktree files do not block provider cancellation", async t => {
  const f = await fixture(t); await f.send(delegation()); await f.tick(2);
  const thread = [...f.threads.values()][0];
  const moved = thread.worktreePath + "-moved"; await rename(thread.worktreePath, moved);
  await f.send(followup("cancel", "cancel")); await f.tick();
  assert.ok(f.commands.some(c => c.type === "thread.session.stop"));
  assert.equal(thread.session.status, "stopped");
});

test("unmarked delegated status does not start a workflow", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { state: { id: "review", name: "review", description: "Human review", team: { id: "team-1" } }, delegate: { id: "app" } };
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
});


test("missing required skills fail before execution", async t => {
  const f = await fixture(t);
  f.skills.length = 0;
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
  assert.ok(f.activities.some(a => a.content.type === "error" && /skill/i.test(a.content.body)));
});

test("grilling completes without validation or PR and follow-ups retain the selected prompt after YAML edits", async t => {
  const f = await fixture(t);
  f.options.pullRequests.find = async () => null;
  f.issueOverrides["issue-1"] = { state: { id: "grill-me", name: "grill-me", description: "Unused description", team: { id: "team-1" } } };
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.latestTurn.state = "completed";
  thread.session = { status: "ready", activeTurnId: null, lastError: null };
  thread.messages.push({ id: "result", role: "assistant", turnId: thread.latestTurn.turnId, text: '<bridge-result>{"status":"complete","summary":"Decisions agreed","validation":[],"blockers":[],"context":{"read":["issue"],"summarized":[],"unavailable":[]}}</bridge-result>' });
  await f.tick();
  assert.ok(f.activities.some(a => a.content.type === "response" && /Decisions agreed/.test(a.content.body)));
  f.projectConfig.t3code.workflows[0].statuses["grill-me"].prompt = "Changed prompt";
  await f.restart();
  await f.send(followup("revise", "Revisit the audience")); await f.tick();
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.equal(turns[1].threadId, turns[0].threadId);
  assert.match(turns[1].message.text, /\$grill-me/);
  assert.doesNotMatch(turns[1].message.text, /gh pr create/);
});

const statusEvent = (eventId: string) => ({ type: "Issue", action: "update", organizationId: "workspace-1", webhookId: eventId, data: { id: "issue-1", updatedAt: eventId }, updatedFrom: { stateId: "previous" } });
function move(f: Awaited<ReturnType<typeof fixture>>, workflow: string, id = workflow) {
  f.issueOverrides["issue-1"] = { ...f.issueOverrides["issue-1"], state: { id, name: id, description: workflow ? `t3code: ${workflow}` : "Review", team: { id: "team-1" }, type: "unstarted" } };
}

test("status transitions stop first, honor new-thread and preserve the workspace", async t => {
  const f = await fixture(t);
  move(f, "grill-me");
  await f.send(delegation()); await f.tick();
  const first = [...f.threads.values()][0];
  await writeFile(path.join(first.worktreePath, "preserved.txt"), "keep me");
  f.faults.deferStop = true;
  move(f, "to-spec"); await f.send(statusEvent("transition-1")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  assert.ok(f.commands.some(c => c.type === "thread.session.stop"));
  move(f, "to-tickets"); await f.send(statusEvent("transition-2"));
  await f.restart();
  first.session = { status: "stopped", activeTurnId: null, lastError: null }; first.latestTurn.state = "interrupted";
  await f.tick(14);
  let turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.equal(turns[1].threadId, first.id);
  assert.match(turns[1].message.text, /\$to-tickets/);
  f.faults.deferStop = false;
  f.issueOverrides["issue-1"].title = "Test issue for T3code connectivity";
  move(f, "implement"); await f.send(statusEvent("transition-3")); await f.tick(14);
  assert.equal(f.commands.filter(c => c.type === "thread.create").at(-1).title, "Test project: Test issue for T3code connectivity - implement");
  turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 3);
  assert.notEqual(turns[2].threadId, first.id);
  const implementation = f.threads.get(turns[2].threadId);
  assert.equal(implementation.worktreePath, first.worktreePath);
  assert.equal(implementation.branch, first.branch);
  assert.equal(await readFile(path.join(first.worktreePath, "preserved.txt"), "utf8"), "keep me");
  move(f, "grill-me"); await f.send(statusEvent("transition-4")); await f.tick(14);
  turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.at(-1).threadId, implementation.id);
  await f.send(statusEvent("transition-4")); await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 4);
});

test("spec completion requires a published parent specification", async t => {
  const f = await fixture(t);
  move(f, "to-spec"); await f.send(delegation()); await f.tick();
  finish(f); await f.tick();
  assert.ok(f.activities.some(a => a.content.type === "error" && /specification/i.test(a.content.body)));
  assert.equal(f.activities.filter(a => a.content.type === "response").length, 0);
});


function planningResult(f: Awaited<ReturnType<typeof fixture>>, artifacts: object, summary = "Planning ready") {
  const turn = f.commands.filter(c => c.type === "thread.turn.start").at(-1);
  const thread = f.threads.get(turn.threadId);
  thread.latestTurn.state = "completed"; thread.session = { status: "ready", activeTurnId: null, lastError: null };
  thread.messages.push({ id: `result-${thread.latestTurn.turnId}`, role: "assistant", turnId: thread.latestTurn.turnId, text: `<bridge-result>${JSON.stringify({ status: "complete", summary, artifacts, validation: [], blockers: [], context: { read: ["issue"], summarized: [], unavailable: [] } })}</bridge-result>` });
}

test("parent specification publication reconciles lost acknowledgement across restart", async t => {
  const f = await fixture(t);
  move(f, "to-spec"); await f.send(delegation()); await f.tick();
  planningResult(f, { specification: { previousDescription: "Use https://example.org/design", description: "Original problem: design.\n\nAgreed specification with acceptance criteria." } });
  f.faults.dropArtifact = true;
  await f.tick(2); await f.restart(); await f.tick(12);
  assert.match(f.issueOverrides["issue-1"].description, /Agreed specification/);
  assert.equal(f.artifactWrites.filter(w => w.query.includes("BridgeArtifactUpdate")).length, 1);
  assert.equal(f.comments.length, 1);
  assert.ok(f.activities.some(a => a.content.type === "response" && /Planning ready/.test(a.content.body)));
});

test("ticket re-entry retains child identities, reconciles dependencies, and flags active children", async t => {
  const f = await fixture(t);
  move(f, "to-tickets"); await f.send(delegation()); await f.tick();
  const child = (key: string, blockedBy: string[] = []) => ({ key, title: key, description: `Scope for ${key}`, acceptanceCriteria: [`${key} works`], blockedBy });
  planningResult(f, { approved: true, children: [child("second", ["first"]), child("first")] });
  await f.tick(20);
  const created = f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate"));
  assert.equal(created.length, 2);
  assert.equal(f.relations.length, 1);
  for (const c of created) {
    assert.equal(c.variables.input.parentId, "issue-1");
    assert.match(c.variables.input.description, /Acceptance criteria/);
    assert.match(c.variables.input.description, /Source specification: https:\/\/linear.app/);
    assert.equal(c.variables.input.delegateId, undefined);
  }
  const firstId = created.find(c => c.variables.input.title === "first").variables.input.id;
  f.issueOverrides[firstId].state = { type: "started" };
  move(f, "grill-me"); await f.send(statusEvent("tickets-back")); await f.tick(12);
  move(f, "to-tickets"); await f.send(statusEvent("tickets-again")); await f.tick(12);
  planningResult(f, { approved: true, children: [{ ...child("second"), description: "Revised scope" }, { ...child("first"), description: "Do not overwrite active work" }] });
  await f.tick(20);
  assert.equal(f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate")).length, 2);
  assert.equal(f.relations.length, 0);
  assert.doesNotMatch(f.issueOverrides[firstId].description, /Do not overwrite/);
  assert.ok(f.comments.some(c => /Human review required/.test(c.body)));
});

test("moving to review or removing delegation retires unanswered questions and blocks resume", async t => {
  const f = await fixture(t);
  f.projects[0]!.defaultThreadEnvMode = "local";
  move(f, "grill-me"); await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "question-activity", kind: "user-input.requested", summary: "Audience?", tone: "info", turnId: thread.latestTurn.turnId, payload: { requestId: "old-question", questions: [{ id: "audience", question: "Audience?" }] } });
  await f.tick();
  await f.send(followup("old-followup", "obsolete queued work"));
  move(f, "", "review"); await f.send(statusEvent("review-move")); await f.tick(12);
  await f.send(followup("stale-answer", 'answer old-question {"audience":"everyone"}'));
  await f.send(followup("holding-resume", "resume")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  assert.equal(f.commands.filter(c => c.type === "thread.user-input.respond").length, 0);
  move(f, "to-spec"); await f.send(statusEvent("return-from-review")); await f.tick(12);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  assert.equal(f.threads.size, 1);
  f.issueOverrides["issue-1"].delegate = null;
  await f.send({ ...statusEvent("removed-delegation"), updatedFrom: { delegateId: "app" } }); await f.tick(12);
  await f.send(followup("withdrawn-resume", "resume")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  assert.equal(await readFile(path.join(f.repo, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
});

test("ordinary board movement cannot create sessions and stale issue events do not rerun a stage", async t => {
  const f = await fixture(t);
  await f.send(statusEvent("unrelated")); await f.tick();
  assert.equal(f.commands.length, 0);
  move(f, "grill-me"); await f.send(delegation()); await f.tick();
  planningResult(f, {}); await f.tick();
  await f.send(statusEvent("stale-event")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
});

test("publication conflict accepts revision feedback with refreshed context", async t => {
  const f = await fixture(t);
  move(f, "to-spec"); await f.send(delegation()); await f.tick();
  planningResult(f, { specification: { previousDescription: "Use https://example.org/design", description: "Draft from stale context" } });
  await f.tick(1);
  f.issueOverrides["issue-1"].description = "Human corrected requirements";
  await f.tick();
  await f.send(followup("revise-conflict", "Revise using my corrected requirements")); await f.tick();
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.match(turns[1].message.text, /Human corrected requirements/);
  assert.equal(f.issueOverrides["issue-1"].description, "Human corrected requirements");
});

test("ticket revision adopts an existing dependency identity before later removal", async t => {
  const f = await fixture(t);
  move(f, "to-tickets"); await f.send(delegation()); await f.tick();
  const children = ["first", "second"].map(key => ({ key, title: key, description: key, acceptanceCriteria: ["works"], blockedBy: [] as string[] }));
  planningResult(f, { approved: true, children }); await f.tick(16);
  const writes = f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate"));
  const first = writes.find(w => w.variables.input.title === "first").variables.input.id;
  const second = writes.find(w => w.variables.input.title === "second").variables.input.id;
  f.relations.push({ id: "human-edge", type: "blocks", issueId: first, relatedIssueId: second });
  await f.send(followup("adopt-edge", "Keep the dependency I added")); await f.tick();
  children[1]!.blockedBy = ["first"];
  planningResult(f, { approved: true, children }); await f.tick(16);
  assert.equal(f.relations.length, 1);
  await f.send(followup("remove-edge", "Remove the dependency")); await f.tick();
  children[1]!.blockedBy = [];
  planningResult(f, { approved: true, children }); await f.tick(16);
  assert.equal(f.relations.length, 0);
});

test("grilling stays in the sidebar with natural replies and no copied transcript in fresh threads", async t => {
  const f = await fixture(t);
  move(f, "grill-me"); await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "qa-activity", kind: "user-input.requested", summary: "Audience?", tone: "info", turnId: thread.latestTurn.turnId, payload: { requestId: "qa-request", responseMode: "message", questions: [{ id: "audience", question: "Who is the audience?", options: [{ label: "Operators", description: "Internal users" }, { label: "Customers" }] }] } });
  await f.tick();
  const question = f.activities.find(a => a.content.type === "elicitation").content.body;
  assert.match(question, /Who is the audience/); assert.match(question, /A\.\*\* Operators — Internal users/);
  assert.doesNotMatch(question, /qa-request|responseMode|requestId|JSON/);
  await f.restart();
  await f.send(followup("wrong-question", "2B")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.user-input.respond").length, 0);
  assert.match(f.activities.filter(a => a.content.type === "elicitation").at(-1).content.body, /does not match the current question/);
  await f.send(followup("qa-answer", "1A")); await f.send(followup("qa-answer", "1A")); await f.tick();
  const answers = f.commands.filter(c => c.type === "thread.user-input.respond");
  assert.equal(answers.length, 1); assert.deepEqual(answers[0].answers, { audience: "Operators" });
  assert.equal(f.comments.length, 0);
  await f.restart();
  move(f, "implement"); await f.send(statusEvent("fresh-thread")); await f.tick(14);
  const turn = f.commands.filter(c => c.type === "thread.turn.start").at(-1);
  assert.notEqual(turn.threadId, thread.id);
  assert.doesNotMatch(turn.message.text, /Who is the audience|Submitted reply:/);
  assert.equal(f.comments.length, 0);
});

test("several questions collect natural answers one at a time across restart", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick();
  const thread = [...f.threads.values()][0];
  thread.activities.push({ id: "multi-question", kind: "user-input.requested", summary: "Details", tone: "info", turnId: thread.latestTurn.turnId, payload: { requestId: "details", questions: [
    { id: "audience", question: "Who will use this?" },
    { id: "checks", question: "Which checks?", multiSelect: true, options: [{ label: "Lint" }, { label: "Tests" }] },
  ] } });
  await f.tick();
  await f.send(followup("first-answer", "Our support team")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.user-input.respond").length, 0);
  assert.match(f.activities.filter(a => a.content.type === "elicitation").at(-1).content.body, /Question 2[\s\S]*Which checks/);
  await f.restart(); await f.send(followup("second-answer", "2A, 2B")); await f.tick();
  assert.deepEqual(f.commands.find(c => c.type === "thread.user-input.respond").answers, { audience: "Our support team", checks: ["Lint", "Tests"] });
});

test("delegated implementation child gets fresh parent specification and decisions", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { parent: { id: "parent" }, title: "Implement child scope", description: "Acceptance: child works" };
  f.issueOverrides.parent = { title: "Parent feature", description: "Authoritative parent specification", comments: { nodes: [{ id: "decision", body: "Agreed decision: operators only", createdAt: "2026-09-15T00:00:00Z", user: { name: "Human" } }], pageInfo: { hasNextPage: false } } };
  await f.send(delegation()); await f.tick();
  const turn = f.commands.find(c => c.type === "thread.turn.start");
  assert.ok(turn);
  assert.match(turn.message.text, /Authoritative parent specification/);
  assert.match(turn.message.text, /Agreed decision: operators only/);
  assert.match(turn.message.text, /Acceptance: child works/);
  assert.equal(f.threads.size, 1);
});

test("missing parent specification prevents child implementation", async t => {
  const f = await fixture(t);
  f.issueOverrides["issue-1"] = { parent: { id: "parent" } };
  f.issueOverrides.parent = { description: null };
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 0);
  assert.ok(f.activities.some(a => a.content.type === "error" && /parent specification/.test(a.content.body)));
});

test("re-delegation supersedes the old issue session across status moves and restart", async t => {
  const f = await fixture(t);
  f.options.concurrency = 2;
  move(f, "grill-me"); await f.send(delegation()); await f.tick();
  const oldThread = [...f.threads.values()][0];
  f.issueOverrides["issue-1"].delegate = null;
  await f.send({ ...statusEvent("withdraw-old"), updatedFrom: { delegateId: "app" } }); await f.tick(12);
  f.issueOverrides["issue-1"].delegate = { id: "app" };
  await f.send({ ...delegation("replacement"), agentSession: { id: "replacement", issue: { id: "issue-1" } } });
  await f.send({ ...statusEvent("redelegate"), updatedFrom: { delegateId: null } });
  await f.restart(); await f.tick(20);
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.notEqual(turns[1].threadId, oldThread.id);
  await f.send(followup("late-old-reply", "resume"));
  move(f, "to-spec"); await f.send(statusEvent("replacement-spec")); await f.tick(16);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start" && c.threadId === oldThread.id).length, 1);
});

test("explicit cancellation retires prepared publication before later feedback", async t => {
  const f = await fixture(t);
  move(f, "to-spec"); await f.send(delegation()); await f.tick();
  planningResult(f, { specification: { previousDescription: "Use https://example.org/design", description: "Cancelled specification" } });
  await f.tick(1);
  await f.send(followup("cancel-prepared", "cancel")); await f.tick();
  await f.restart();
  await f.send(followup("discard-prepared", "Discard that specification and reconsider the requirements")); await f.tick(12);
  assert.equal(f.artifactWrites.length, 0);
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.match(turns[1].message.text, /Discard that specification/);
  assert.equal(f.activities.filter(a => a.content.type === "response").length, 0);
});

test("rejected ticket preparation never reports completion and accepts corrected feedback", async t => {
  const f = await fixture(t);
  move(f, "to-tickets"); await f.send(delegation()); await f.tick();
  const child = { key: "duplicate", title: "Scope", description: "Scope", acceptanceCriteria: ["works"], blockedBy: [] };
  planningResult(f, { approved: true, children: [child, child] });
  await f.tick(12); await f.restart(); await f.tick();
  assert.equal(f.artifactWrites.length, 0);
  assert.equal(f.activities.filter(a => a.content.type === "response").length, 0);
  assert.ok(f.activities.some(a => a.content.type === "error" && /unique/.test(a.content.body)));
  await f.send(followup("correct-keys", "Use a single ticket with a unique key")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  planningResult(f, { approved: true, children: [child] }); await f.tick(12);
  assert.equal(f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate")).length, 1);
  assert.equal(f.activities.filter(a => a.content.type === "response").length, 1);
});

test("replacement delegation waits for superseded provider stop even with spare capacity", async t => {
  const f = await fixture(t);
  f.options.concurrency = 2;
  move(f, "grill-me"); await f.send(delegation()); await f.tick();
  const oldThread = [...f.threads.values()][0];
  await writeFile(path.join(oldThread.worktreePath, "ticket-work.txt"), "preserved changes");
  f.issueOverrides["issue-1"].title = "Renamed while working";
  f.faults.deferStop = true;
  const replacement = { ...delegation("replacement"), agentSession: { id: "replacement", issue: { id: "issue-1" } } };
  await f.send(replacement); await f.tick(); await f.restart();
  await f.send(replacement); await f.send(followup("old-feedback", "resume")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  assert.equal(f.threads.size, 1);
  oldThread.session = { status: "stopped", activeTurnId: null, lastError: null };
  oldThread.latestTurn.state = "interrupted";
  await f.tick(12);
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.notEqual(turns[1].threadId, oldThread.id);
  const replacementThread = f.threads.get(turns[1].threadId);
  assert.equal(replacementThread.branch, oldThread.branch);
  assert.equal(replacementThread.worktreePath, oldThread.worktreePath);
  assert.equal(turns[1].bootstrap, undefined);
  assert.equal(await readFile(path.join(replacementThread.worktreePath, "ticket-work.txt"), "utf8"), "preserved changes");
});


test("authoritative session ownership survives reversed creation and delegation events", async t => {
  const f = await fixture(t);
  f.options.concurrency = 2;
  move(f, "grill-me"); await f.send(delegation()); await f.tick();
  const oldThread = [...f.threads.values()][0];
  f.issueOverrides["issue-1"].delegate = null;
  await f.send({ ...statusEvent("withdraw-order"), updatedFrom: { delegateId: "app" } }); await f.tick(12);
  f.linearSessions.set("newest", { id: "newest", issueId: "issue-1", createdAt: "2026-01-03T00:00:00Z", appUser: { id: "app" } });
  f.issueOverrides["issue-1"].delegate = { id: "app" };
  await f.send({ ...statusEvent("restore-before-created"), updatedFrom: { delegateId: null } }); await f.tick(12);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  await f.send({ ...delegation("newest"), agentSession: { id: "newest", issue: { id: "issue-1" } } }); await f.tick(12);
  const newThread = f.commands.filter(c => c.type === "thread.turn.start").at(-1).threadId;
  f.linearSessions.set("delayed-older", { id: "delayed-older", issueId: "issue-1", createdAt: "2026-01-02T00:00:00Z", appUser: { id: "app" } });
  await f.send({ ...delegation("delayed-older"), agentSession: { id: "delayed-older", issue: { id: "issue-1" } } }); await f.restart(); await f.tick(16);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
  assert.equal(f.commands.filter(c => c.type === "thread.session.stop" && c.threadId === newThread).length, 0);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start" && c.threadId === oldThread.id).length, 1);
});


test("cancellation during publication preflight prevents the pending mutation", async t => {
  const f = await fixture(t);
  move(f, "to-spec"); await f.send(delegation()); await f.tick();
  planningResult(f, { specification: { previousDescription: "Use https://example.org/design", description: "Must not be published after cancellation" } });
  await f.tick(1);
  // The first read is the status gate; the second is the publication preflight.
  const held = f.holdIssueRead(2);
  const publishing = f.tick(1);
  await held.reached;
  await f.send(followup("cancel-during-read", "cancel"));
  held.release(); await publishing; await f.tick();
  assert.equal(f.artifactWrites.length, 0);
  await f.restart(); await f.send(followup("discard-after-read", "Discard the previous draft")); await f.tick();
  assert.equal(f.artifactWrites.length, 0);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 2);
});

test("replacement sessions retain ticket and dependency identities", async t => {
  const f = await fixture(t);
  move(f, "to-tickets"); await f.send(delegation()); await f.tick();
  const children = ["first", "second"].map(key => ({ key, title: key, description: key, acceptanceCriteria: ["works"], blockedBy: key === "second" ? ["first"] : [] }));
  planningResult(f, { approved: true, children }); await f.tick(16);
  const ids = f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate")).map(w => w.variables.input.id);
  const relationId = f.relations[0].id;
  await f.send({ ...delegation("replacement"), agentSession: { id: "replacement", issue: { id: "issue-1" } } });
  await f.restart(); await f.tick(16);
  planningResult(f, { approved: true, children }); await f.tick(16);
  assert.deepEqual(f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate")).map(w => w.variables.input.id), ids);
  assert.deepEqual(f.relations.map(r => r.id), [relationId]);
  await f.send(followup("remove-inherited-dependency", "Remove the dependency", "replacement")); await f.tick();
  children[1]!.blockedBy = [];
  planningResult(f, { approved: true, children }); await f.tick(16);
  assert.equal(f.relations.length, 0);
});


test("child revision preserves human edits made after the supplied context", async t => {
  const f = await fixture(t);
  move(f, "to-tickets"); await f.send(delegation()); await f.tick();
  const child = { key: "stable", title: "Original scope", description: "Original description", acceptanceCriteria: ["works"], blockedBy: [] };
  planningResult(f, { approved: true, children: [child] }); await f.tick(12);
  const id = f.artifactWrites.find(w => w.query.includes("BridgeArtifactCreate")).variables.input.id;
  await f.send(followup("revise-child", "Refine this child")); await f.tick();
  f.issueOverrides[id].title = "Human corrected title";
  f.issueOverrides[id].description = "Human corrected acceptance criteria";
  await f.restart();
  planningResult(f, { approved: true, children: [{ ...child, description: "Agent revision from stale context" }] }); await f.tick(12);
  assert.equal(f.issueOverrides[id].title, "Human corrected title");
  assert.equal(f.issueOverrides[id].description, "Human corrected acceptance criteria");
  assert.ok(f.activities.some(a => a.content.type === "error" && /changed|context/.test(a.content.body)));
  await f.send(followup("reconcile-human-edit", "Revise using my correction")); await f.tick();
  const turn = f.commands.filter(c => c.type === "thread.turn.start").at(-1);
  assert.match(turn.message.text, /Human corrected acceptance criteria/);
  planningResult(f, { approved: true, children: [{ ...child, title: "Human corrected title", description: "Agreed revision after correction" }] }); await f.tick(12);
  assert.match(f.issueOverrides[id].description, /Agreed revision after correction/);
});

test("ticket keys matching object properties receive stable UUID identities", async t => {
  const f = await fixture(t);
  move(f, "to-tickets"); await f.send(delegation()); await f.tick();
  const children = ["constructor", "__proto__", "toString"].map(key => ({ key, title: key, description: `Scope for ${key}`, acceptanceCriteria: ["works"], blockedBy: key === "__proto__" ? ["constructor"] : [] }));
  planningResult(f, { approved: true, children }); await f.tick(20);
  const created = f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate"));
  assert.equal(created.length, 3);
  for (const write of created) assert.match(write.variables.input.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(f.relations.length, 1);
  await f.restart(); await f.send(followup("repeat-reserved-keys", "Keep the same scopes")); await f.tick();
  planningResult(f, { approved: true, children }); await f.tick(20);
  assert.equal(f.artifactWrites.filter(w => w.query.includes("BridgeArtifactCreate")).length, 3);
});

test("custom status prompts and optional skills are independent of output contracts", async t => {
  const f = await fixture(t);
  f.skills.length = 0;
  f.options.pullRequests.find = async () => null;
  f.projectConfig.t3code.instructions = "Shared Zenith instructions.";
  f.projectConfig.t3code.workflows[0].statuses = {
    implement: { output: "comment", prompt: "Review the design.\n\nExplain the tradeoffs without coding." },
  };
  await f.send(delegation()); await f.tick();
  const turn = f.commands.find(c => c.type === "thread.turn.start");
  assert.match(turn.message.text, /Shared Zenith instructions/);
  assert.match(turn.message.text, /Review the design\.\n\nExplain the tradeoffs/);
  assert.doesNotMatch(turn.message.text, /Invoke \$implement|gh pr create/);
  planningResult(f, {}, "Design reviewed"); await f.tick();
  assert.ok(f.comments.some(c => /Design reviewed/.test(c.body)));
  assert.ok(f.activities.some(a => a.content.type === "response" && /Design reviewed/.test(a.content.body)));
});

test("agent-managed workflow follows its status prompt without bridge publication", async t => {
  const f = await fixture(t);
  f.projectConfig.t3code.workflows[0].statuses.implement = {
    output: "agent-managed", prompt: "Save the review report in Linear, ask for the handoff decision, then apply it after the answer.",
  };
  await f.send(delegation()); await f.tick();
  const turn = f.commands.find(c => c.type === "thread.turn.start");
  assert.match(turn.message.text, /Save the review report in Linear/);
  assert.doesNotMatch(turn.message.text, /Never advance statuses|Return publication content|<bridge-result>/);
  const thread = f.threads.get(turn.threadId);
  thread.activities.push({ id: "handoff-question", kind: "user-input.requested", tone: "info", summary: "Choose handoff", turnId: thread.latestTurn.turnId, payload: { requestId: "handoff", questions: [{ id: "decision", question: "Where next?", options: [{ label: "Back to Implementation" }, { label: "Forward to UAT" }] }] } });
  await f.tick();
  assert.ok(f.activities.some(a => a.content.type === "elicitation" && /Back to Implementation/.test(a.content.body) && /Forward to UAT/.test(a.content.body)));
  await f.send(followup("handoff-answer", "Back to Implementation")); await f.tick();
  assert.ok(f.commands.some(c => c.type === "thread.user-input.respond" && c.requestId === "handoff"));
  thread.latestTurn.state = "completed";
  thread.session = { status: "ready", activeTurnId: null, lastError: null };
  thread.messages.push({ id: "review-complete", role: "assistant", turnId: thread.latestTurn.turnId, text: "Review report saved; awaiting the user's handoff decision in Linear." });
  await f.tick();
  assert.equal(f.comments.length, 0);
  assert.ok(f.activities.some(a => a.content.type === "response" && /Review report saved/.test(a.content.body)));
  assert.ok(!f.activities.some(a => a.content.type === "error" && /validation\/context report/.test(a.content.body)));
});

test("external review preserves the implementation thread without starting a review turn", async t => {
  const f = await fixture(t);
  f.projectConfig.t3code.workflows[0].statuses.review = { output: "external-review", "new-thread": true, prompt: "Wait for CodeRabbit." };
  await f.send(delegation()); await f.tick();
  const implementation = f.commands.find(c => c.type === "thread.create");
  assert.ok(implementation);
  finish(f); await f.tick();
  move(f, "review"); await f.send(statusEvent("to-external-review")); await f.tick(14);
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  assert.equal(f.threads.size, 1);
  await f.restart(); await f.send(followup("review-followup", "Any news?")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
  move(f, "implement"); await f.send(statusEvent("back-to-implementation")); await f.tick(14);
  const turns = f.commands.filter(c => c.type === "thread.turn.start");
  assert.equal(turns.length, 2);
  assert.notEqual(turns[1].threadId, implementation.threadId);
  assert.equal(f.threads.get(turns[1].threadId).branch, f.threads.get(implementation.threadId).branch);
});

test("external review without prior implementation pauses without creating a thread", async t => {
  const f = await fixture(t);
  f.projectConfig.t3code.workflows[0].statuses.review = { output: "external-review", prompt: "Wait for CodeRabbit." };
  move(f, "review");
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
  assert.ok(f.activities.some(a => /requires an existing implementation thread/.test(a.content.body)));
});

test("new-thread applies on re-entry but never on follow-ups or restart", async t => {
  const f = await fixture(t);
  f.projectConfig.t3code.workflows[0].statuses.implement = { output: "comment", "new-thread": true, prompt: "Review this issue." };
  await f.send(delegation()); await f.tick();
  const first = f.commands.find(c => c.type === "thread.turn.start");
  planningResult(f, {}, "Reviewed"); await f.tick();
  await f.restart(); await f.send(followup("review-followup", "Explain more")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").at(-1).threadId, first.threadId);
  move(f, "", "review"); await f.send(statusEvent("holding")); await f.tick(12);
  f.projectConfig.t3code.workflows[0].statuses.implement.prompt = "Review again with the updated instructions.";
  move(f, "implement"); await f.send(statusEvent("reenter")); await f.tick(12);
  const latest = f.commands.filter(c => c.type === "thread.turn.start").at(-1);
  assert.notEqual(latest.threadId, first.threadId);
  assert.match(latest.message.text, /Review again with the updated instructions/);
  assert.equal(f.threads.get(latest.threadId).worktreePath, f.threads.get(first.threadId).worktreePath);
});

test("long YAML prompts use a complete file without repeating oversized instructions in transport", async t => {
  const f = await fixture(t);
  const prompt = "Detailed project instruction.\n".repeat(5000) + "END OF YAML PROMPT";
  f.projectConfig.t3code.workflows[0].statuses.implement.prompt = prompt;
  await f.send(delegation()); await f.tick();
  const text = f.commands.find(c => c.type === "thread.turn.start").message.text;
  assert.ok(text.length < 100000);
  const file = /complete delegated turn at (.+?) before acting/.exec(text);
  assert.ok(file);
  const full = await readFile(file[1], "utf8");
  assert.ok(full.includes(prompt));
  assert.match(full, /<bridge-result>/);
});

test("unknown configured status pauses even if a different status is selected", async t => {
  const f = await fixture(t);
  f.projectConfig.t3code.workflows[0].statuses.Missing = { prompt: "Review", output: "comment" };
  await f.send(delegation()); await f.tick();
  assert.equal(f.commands.length, 0);
  assert.ok(f.activities.some(a => /Status "Missing"/.test(a.content.body)));
  delete f.projectConfig.t3code.workflows[0].statuses.Missing;
  await f.restart(); await f.tick(); assert.equal(f.commands.length, 0);
  await f.send(followup("fixed-status", "resume")); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.turn.start").length, 1);
});

test("replacement delegation cannot reopen a retired ticket workspace", async t => {
  const f = await fixture(t);
  await f.send(delegation()); await f.tick(); finish(f); await f.tick();
  f.pr.state = "MERGED"; await f.tick(); await f.restart();
  await f.send({ ...delegation("replacement"), agentSession: { id: "replacement", issue: { id: "issue-1" } } });
  await f.tick(12);
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  assert.ok(f.activities.some(a => a.agentSessionId === "replacement" && /workspace is retired/.test(a.content.body)));
});

test("replacement with a missing ticket worktree pauses without allocating another", async t => {
  const f = await fixture(t);
  move(f, "grill-me"); await f.send(delegation()); await f.tick();
  const original = [...f.threads.values()][0];
  await rename(original.worktreePath, original.worktreePath + "-moved");
  await f.send({ ...delegation("replacement"), agentSession: { id: "replacement", issue: { id: "issue-1" } } });
  await f.tick(12); await f.restart(); await f.tick();
  assert.equal(f.commands.filter(c => c.type === "thread.create").length, 1);
  assert.ok(f.activities.some(a => a.agentSessionId === "replacement" && /ticket worktree is missing/.test(a.content.body)));
});
