import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { BridgeStore } from "./bridge-store.js";
import type { Runner, RunnerCommand, RunnerThread } from "./runner.js";
import { LinearClient } from "./linear-context.js";
import { prepareWorktree, verifyProjectRepository, type Route } from "./repository.js";
import { deliveryInstructions, deliveryResult } from "./delivery.js";
import { cleanupWorktree, type PullRequests, type PullRequest } from "./pull-requests.js";
import { IntegrationError } from "./t3code-runner.js";
import { redact } from "./progress.js";

const WebhookSchema = z.object({
  action: z.enum(["created", "prompted"]), organizationId: z.string().min(1),
  agentSession: z.object({ id: z.string().min(1), issue: z.object({ id: z.string().min(1) }).nullish() }),
  agentActivity: z.object({ id: z.string().optional(), signal: z.string().nullish(), content: z.object({ type: z.string().optional(), body: z.string().optional() }).optional() }).optional(),
  promptContext: z.string().optional(), guidance: z.array(z.object({ body: z.string().optional() }).passthrough()).nullish(),
});
type Webhook = z.infer<typeof WebhookSchema>;
type QueuedTurn = { id: string; body: string };
type PendingRequest = { id: string; kind: "approval" | "question"; description: string; responseMode?: string; questions?: Array<{ id: string; question: string; multiSelect?: boolean }>; };
type Session = {
  id: string; workspaceId: string; issueId: string; teamId?: string;
  threadId: string; branch: string; worktree: string; route?: Route;
  status: "queued" | "running" | "paused" | "cancelled" | "cancelling" | "idle" | "closed";
  queue: QueuedTurn[]; command?: RunnerCommand;
  pendingProgress?: string; lastProgress?: string;
  pr?: PullRequest; lastPrCheckAt?: number; cleanup?: string;
  requests: PendingRequest[]; responses: RunnerCommand[];
  generation: number; cancelCommand?: RunnerCommand; interrupted?: boolean; stopSent?: boolean;
  created: boolean; active?: { messageId: string; turnId?: string; previousTurnId?: string };
  sequence: number; seenActivities: string[]; createdAt: string; updatedAt: string;
  lastReportAt: number; lastError?: string; contextFingerprint?: string;
};
type Outbound = { attempted?: boolean; id: string; sessionId: string; type: "thought" | "error" | "response" | "elicitation"; body: string };
type State = { workspaceId?: string; sessions: Record<string, Session>; deliveries: string[]; outbox: Outbound[] };
export type BridgeOptions = {
  databasePath: string; worktreeRoot: string; routes: Record<string, Route>;
  pullRequests: PullRequests; prPollMs: number;
  concurrency: number; runner: Runner; linear: LinearClient;
  pollMs: number; heartbeatMs: number; progressDebounceMs: number;
};

export class Bridge {
  private readonly store: BridgeStore<State>;
  private ticking?: Promise<void>;
  private timer?: NodeJS.Timeout;
  constructor(private readonly options: BridgeOptions) {
    this.store = new BridgeStore(options.databasePath, { sessions: {}, deliveries: [], outbox: [] });
  }
  start() { this.timer ??= setInterval(() => { void this.tick().catch(() => console.error("bridge tick failed; check durable storage")); }, this.options.pollMs); }
  async close() { clearInterval(this.timer); await this.ticking; this.store.close(); }
  accept(input: unknown): void {
    const payload = WebhookSchema.parse(input);
    const id = payload.agentSession.id;
    const activityId = payload.agentActivity?.id;
    if (payload.action === "prompted" && !activityId) throw new Error("Prompted webhook requires agentActivity.id for durable deduplication.");
    const delivery = `${payload.organizationId}:${id}:${payload.action === "created" ? "created" : activityId}`;
    this.store.update(state => {
      if (state.workspaceId && state.workspaceId !== payload.organizationId) throw new Error("Workspace does not match this installation.");
      state.workspaceId = payload.organizationId;
      if (state.deliveries.includes(delivery)) return;
      state.deliveries.push(delivery);
      let session = Object.hasOwn(state.sessions, id) ? state.sessions[id] : undefined;
      if (!session) {
        if (!payload.agentSession.issue?.id) throw new Error("Agent session requires an issue ID.");
        const threadId = randomUUID();
        const now = new Date().toISOString();
        session = state.sessions[id] = {
          id, workspaceId: payload.organizationId, issueId: payload.agentSession.issue.id,
          threadId, branch: `linear/${threadId}`, worktree: path.resolve(this.options.worktreeRoot, threadId),
          status: "queued", queue: [], created: false, generation: 0, requests: [], responses: [], sequence: 0, seenActivities: [],
          createdAt: now, updatedAt: now, lastReportAt: Date.now(),
        };
      }
      if (session.workspaceId !== payload.organizationId) throw new Error("Workspace does not match the existing session.");
      if (session.status === "closed") {
        this.report(state, session, "error", "This session's PR is closed or merged. Start a new delegation for further implementation.");
        return;
      }
      const body = payload.agentActivity?.content?.body?.trim().toLowerCase();
      if (payload.agentActivity?.signal === "stop" || ["stop", "cancel", "cancelled", "canceled"].includes(body ?? "")) {
        this.requestCancellation(session);
        state.outbox = state.outbox.filter(o => o.sessionId !== id);
        return;
      }
      if (body === "resume" && session.status === "paused") {
        session.status = "queued";
        delete session.lastError;
        if (!session.queue.length && !session.active) session.queue.push({ id: randomUUID(), body: "Resume the previous task, inspect its failure and complete the remaining work." });
        this.report(state, session, "thought", "Resuming preserved work and queued prompts.");
        return;
      }
      const reply = payload.agentActivity?.content?.body?.trim() ?? "";
      const match = /^(approve|decline|answer)\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(reply);
      if (match) {
        const request = session.requests.find(r => r.id === match[2]);
        if (!request) {
          this.report(state, session, "elicitation", "That request is not pending. Use the request ID shown in the current question or approval.");
          return;
        }
        const verb = match[1].toLowerCase();
        const command: RunnerCommand = { type: "", commandId: randomUUID(), threadId: session.threadId, requestId: request.id, createdAt: new Date().toISOString() };
        if (request.kind === "approval" && (verb === "approve" || verb === "decline") && !match[3]) {
          command.type = "thread.approval.respond"; command.decision = verb === "approve" ? "accept" : "decline";
        } else if (request.kind === "question" && verb === "answer") {
          let answers: unknown;
          try { answers = JSON.parse(match[3] ?? ""); } catch { /* Explain the required answer format below. */ }
          const parsed = z.record(z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])).safeParse(answers);
          if (!parsed.success || !request.questions?.every(q => Object.hasOwn(parsed.data, q.id) && (!Array.isArray(parsed.data[q.id]) || (request.responseMode !== "message" && q.multiSelect === true)))) {
            this.report(state, session, "elicitation", `Reply with answer ${request.id} followed by a JSON object containing an answer for each question ID.`);
            return;
          }
          command.type = "thread.user-input.respond"; command.answers = parsed.data;
        } else {
          this.report(state, session, "elicitation", `Use the explicit response format for request ${request.id}. No approval was granted.`);
          return;
        }
        if (!session.responses.some(r => r.requestId === request.id)) session.responses.push(command);
        return;
      }
      session.queue.push({ id: randomUUID(), body: this.prompt(payload) });
      if (session.status === "idle" || session.status === "cancelled") session.status = "queued";
      this.report(state, session, "thought", "Delegation received and durably queued for T3Code.");
    });
  }
  private prompt(payload: Webhook) {
    return [payload.agentActivity?.content?.body, payload.promptContext, ...(payload.guidance ?? []).map(g => g.body)].filter(Boolean).join("\n\n");
  }
  private report(state: State, session: Session, type: Outbound["type"], body: string) {
    const clean = redact(body);
    const chunks = clean.match(/[\s\S]{1,8000}/gu) ?? [""];
    for (let i = 0; i < chunks.length; i++) state.outbox.push({ id: randomUUID(), sessionId: session.id,
      type: i === chunks.length - 1 ? type : "thought", body: chunks.length > 1 ? `[${i + 1}/${chunks.length}] ${chunks[i]}` : chunks[i] });
    console.log("bridge activity queued", { agentSessionId: session.id, issueId: session.issueId, threadId: session.threadId, lifecycle: session.status, activityType: type });
    session.lastReportAt = Date.now();
  }
  private session(id: string) { return this.store.read().sessions[id]!; }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.work().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async work() {
    for (const outgoing of this.store.read().outbox) {
      try {
        if (!this.store.read().outbox.some(o => o.id === outgoing.id)) continue;
        this.store.update(s => { s.outbox.find(o => o.id === outgoing.id)!.attempted = true; });
        await this.options.linear.activity(outgoing.sessionId, { type: outgoing.type, body: redact(outgoing.body) }, outgoing.id, outgoing.attempted);
        this.store.update(s => { s.outbox = s.outbox.filter(o => o.id !== outgoing.id); });
      } catch { console.error("Linear activity delivery failed; update retained", { agentSessionId: outgoing.sessionId, activityId: outgoing.id }); break; }
    }
    let running = Object.values(this.store.read().sessions).filter(s => (s.active || s.status === "running" || s.status === "cancelling")).length;
    const eligible: string[] = [];
    for (const session of Object.values(this.store.read().sessions)) {
      if (session.status === "running" || session.status === "cancelling") eligible.push(session.id);
      else if (session.status === "queued" && (session.active || running < this.options.concurrency)) {
        this.store.update(s => { s.sessions[session.id].status = "running"; });
        if (!session.active) running++; eligible.push(session.id);
      } else if (session.pr && session.status !== "closed" && Date.now() - (session.lastPrCheckAt ?? 0) >= this.options.prPollMs) eligible.push(session.id);
    }
    await Promise.all(eligible.map(async id => {
      try { await this.step(id); }
      catch (error) {
        const message = redact(error instanceof Error ? error.message : "Bridge operation failed.");
        this.store.update(state => {
          const session = state.sessions[id];
          if (session.lastError !== message) this.report(state, session, "error", message);
          session.lastError = message;
          if (error instanceof IntegrationError && !error.retryable && session.status !== "cancelling") {
            session.status = "paused";
            this.report(state, session, "error", "Integration requires attention. Work is preserved and paused; repair the configuration or adapter, then send resume.");
          }
        });
      }
    }));
  }
  private requestCancellation(session: Session) {
    session.generation++;
    session.status = "cancelling";
    session.queue = []; session.requests = []; session.responses = [];
    delete session.cancelCommand; delete session.interrupted; delete session.stopSent;
  }
  private assertThreadIdentity(session: Session, thread: RunnerThread) {
    if (thread.projectId !== session.route!.t3ProjectId || thread.branch !== session.branch || thread.worktreePath !== session.worktree) {
      throw new IntegrationError("T3Code thread routing changed; reconcile its project, branch and worktree before resuming.", false);
    }
  }
  private async checkPr(session: Session): Promise<boolean> {
    if (!session.route) return false;
    const pr = await this.options.pullRequests.find(session.route, session.branch);
    if (this.session(session.id).generation !== session.generation) return true;
    this.store.update(s => { s.sessions[session.id].lastPrCheckAt = Date.now(); if (pr) s.sessions[session.id].pr = pr; });
    if (!pr || pr.state === "OPEN") return false;
    // If closure happens during a turn, stop execution before any cleanup.
    if (session.active) {
      this.store.update(s => { const current = s.sessions[session.id]; this.requestCancellation(current); });
      return true;
    }
    let cleanup: string;
    try { cleanup = await cleanupWorktree(session.route, session.worktree); }
    catch { cleanup = "Worktree preserved: cleanup could not verify clean, fully pushed state. Check git access before manual cleanup."; }
    if (this.session(session.id).generation !== session.generation) return true;
    this.store.update(s => {
      const current = s.sessions[session.id]; current.status = "closed"; current.queue = []; current.cleanup = cleanup;
      this.report(s, current, "error", `PR ${pr.url} is ${pr.state.toLowerCase()}. Start a new delegation for further implementation.\n${cleanup}`);
    });
    return true;
  }
  private observe(id: string, thread: RunnerThread, sequence: number, reconciled = false) {
    this.store.update(state => {
      const session = state.sessions[id];
      const previousRequests = session.requests.map(r => r.id);
      if (reconciled) session.requests = [];
      const newActivities = thread.activities.filter(a => !session.seenActivities.includes(a.id));
      for (const activity of reconciled ? thread.activities : newActivities) {
        if (!session.seenActivities.includes(activity.id)) session.seenActivities.push(activity.id);
        const requestId = activity.payload?.requestId;
        if (typeof requestId === "string" && /^(approval|user-input)\.resolved$/.test(activity.kind)) {
          session.requests = session.requests.filter(r => r.id !== requestId);
        }
        if (typeof requestId === "string" && /^(approval|user-input)\.requested$/.test(activity.kind)) {
          const questions = z.array(z.object({ id: z.string(), question: z.string(), multiSelect: z.boolean().optional() })).safeParse(activity.payload?.questions);
          const request: PendingRequest = {
            id: requestId, kind: activity.kind === "approval.requested" ? "approval" : "question",
            description: JSON.stringify(activity.payload, null, 2), responseMode: typeof activity.payload?.responseMode === "string" ? activity.payload.responseMode : undefined, questions: questions.success ? questions.data : undefined,
          };
          session.requests = session.requests.filter(r => r.id !== request.id);
          session.requests.push(request);
        }
      }
      // Only elicit requests still pending after replaying the whole snapshot.
      for (const request of session.requests) {
        if (!(reconciled && !previousRequests.includes(request.id)) && !newActivities.some(a => a.payload?.requestId === request.id && a.kind.endsWith(".requested"))) continue;
        const instruction = request.kind === "approval"
          ? `Reply exactly: approve ${request.id} OR decline ${request.id}.`
          : `Reply: answer ${request.id} followed by a JSON object mapping each question ID to its answer.`;
        this.report(state, session, "elicitation", `${request.description}\n\n${instruction}\nOther follow-ups stay queued. There is no response deadline.`);
      }
      const progress = newActivities.filter(a => !/^(approval|user-input)\./.test(a.kind));
      if (progress.length) session.pendingProgress = progress.at(-1)!.summary;
      if (!session.requests.length && session.active && Date.now() - session.lastReportAt >= this.options.progressDebounceMs && session.pendingProgress && session.pendingProgress !== session.lastProgress) {
        this.report(state, session, "thought", session.pendingProgress);
        session.lastProgress = session.pendingProgress;
        delete session.pendingProgress;
      } else if (session.active && !session.requests.length && Date.now() - session.lastReportAt >= this.options.heartbeatMs) {
        this.report(state, session, "thought", "T3Code is still working. Execution has no bridge deadline.");
      }
      session.sequence = sequence;
      session.updatedAt = new Date().toISOString();
    });
  }
  private async cancel(session: Session) {
    const snapshot = await this.options.runner.snapshot(session.threadId);
    if (this.session(session.id).generation !== session.generation) return;
    if (snapshot && !session.stopSent) {
      const command: RunnerCommand = session.cancelCommand ?? {
        type: session.interrupted ? "thread.session.stop" : "thread.turn.interrupt",
        commandId: randomUUID(), threadId: session.threadId, createdAt: new Date().toISOString(),
      };
      this.store.update(s => { s.sessions[session.id].cancelCommand = command; });
      await this.options.runner.dispatch(command);
      if (this.session(session.id).generation !== session.generation) return;
      if (!session.interrupted) {
        this.store.update(s => { const current = s.sessions[session.id]; current.interrupted = true; delete current.cancelCommand; });
        return;
      }
      this.store.update(s => { s.sessions[session.id].stopSent = true; delete s.sessions[session.id].cancelCommand; });
      return;
    }
    if (snapshot?.thread.session && snapshot.thread.session.status !== "stopped") return;
    this.store.update(s => {
      const current = s.sessions[session.id];
      current.status = current.queue.length ? "queued" : "cancelled";
      current.created = Boolean(snapshot);
      delete current.active; delete current.command; delete current.cancelCommand; delete current.interrupted; delete current.stopSent;
      this.report(s, current, "error", "Stopped by user. Pending prompts cleared; thread, branch, worktree, changes and any PR are preserved.");
    });
  }
  private async step(id: string) {
    let session = this.session(id);
    if (session.status === "cancelling") { await this.cancel(session); return; }
    if (session.pr && Date.now() - (session.lastPrCheckAt ?? 0) >= this.options.prPollMs) {
      if (await this.checkPr(session)) return;
    }
    if (session.status !== "running") return;
    const generation = session.generation;
    const stillCurrent = () => this.session(id).generation === generation;

    if (!session.route) {
      const issue = await this.options.linear.issue(session.issueId);
      if (!stillCurrent()) return;
      const route = issue.project && Object.hasOwn(this.options.routes, issue.project.id) && this.options.routes[issue.project.id];
      if (!route) {
        this.store.update(s => { s.sessions[id].status = "paused"; this.report(s, s.sessions[id], "error", "This Linear project is unmapped. Add its project ID to PROJECT_ROUTES, then send resume."); });
        return;
      }
      const project = (await this.options.runner.projects()).find(p => p.id === route.t3ProjectId);
      if (!project) throw new Error("Mapped T3Code project does not exist. Fix PROJECT_ROUTES and resume.");
      await verifyProjectRepository(route.repository, project.workspaceRoot);
      if (!stillCurrent()) return;
      this.store.update(s => { s.sessions[id].route = route; s.sessions[id].teamId = issue.team.id; });
      session = this.session(id);
    }
    if (!session.created) {
      await prepareWorktree(session.route!, session.worktree, session.branch);
      if (!stillCurrent()) return;
      const command: RunnerCommand = session.command ?? {
        type: "thread.create", commandId: randomUUID(), threadId: session.threadId,
        projectId: session.route!.t3ProjectId, title: `Linear ${session.issueId}`,
        modelSelection: { instanceId: session.route!.provider, model: session.route!.model },
        runtimeMode: "full-access", interactionMode: "default", branch: session.branch,
        worktreePath: session.worktree, createdAt: session.createdAt,
      };
      this.store.update(s => { s.sessions[id].command = command; });
      const existing = await this.options.runner.snapshot(session.threadId);
      if (!stillCurrent()) return;
      if (existing) this.assertThreadIdentity(session, existing.thread);
      if (!existing) await this.options.runner.dispatch(command);
      if (!stillCurrent()) return;
      this.store.update(s => { s.sessions[id].created = true; delete s.sessions[id].command; });
      return;
    }
    let snapshot = await this.options.runner.snapshot(session.threadId);
    if (!stillCurrent()) return;
    if (!snapshot) throw new Error("T3Code thread is missing; restore it before resuming this session.");
    this.assertThreadIdentity(session, snapshot.thread);
    const replayed = await this.options.runner.replay(session.threadId, session.sequence);
    if (!stillCurrent()) return;
    if (replayed.snapshot) {
      snapshot = replayed.snapshot;
      this.assertThreadIdentity(session, snapshot.thread);
      this.store.update(s => this.report(s, s.sessions[id], "thought", "Reconnected from a fresh T3Code snapshot after a large event gap. Pending requests and turn state were reconciled; intermediate progress details are unavailable."));
    }
    const activities = new Map(snapshot.thread.activities.map(activity => [activity.id, activity]));
    for (const event of replayed.events) if (event.sequence <= snapshot.sequence) activities.set(event.activity.id, { ...event.activity, sequence: event.sequence });
    this.observe(id, { ...snapshot.thread, activities: [...activities.values()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)) }, snapshot.sequence, Boolean(replayed.snapshot));
    session = this.session(id);
    if (session.responses.length) {
      const response = session.responses[0];
      try {
        if (session.requests.some(r => r.id === response.requestId)) await this.options.runner.dispatch(response);
      } catch (error) {
        if (!stillCurrent()) return;
        if (!(error instanceof IntegrationError) || error.retryable) throw error;
        this.store.update(s => {
          s.sessions[id].responses.shift();
          this.report(s, s.sessions[id], "elicitation", `T3Code rejected the response for ${String(response.requestId)}. Check the request and credentials, then send a corrected explicit response. No replacement was submitted automatically.`);
        });
        return;
      }
      if (!stillCurrent()) return;
      this.store.update(s => { const current = s.sessions[id]; current.responses.shift(); current.requests = current.requests.filter(r => r.id !== response.requestId); });
      return;
    }
    if (session.command) {
      // A lost acknowledgement is reconciled against the user message first. If absent,
      // T3Code's durable command receipts make replay of the SAME command id safe.
      if (!snapshot.thread.messages.some(m => m.id === session.active?.messageId)) await this.options.runner.dispatch(session.command);
      if (!stillCurrent()) return;
      this.store.update(s => { delete s.sessions[id].command; });
      return;
    }
    if (session.active) {
      if (session.requests.length) return;
      const latest = snapshot.thread.latestTurn;
      if (latest && latest.turnId !== session.active.previousTurnId) {
        this.store.update(s => { s.sessions[id].active!.turnId = latest.turnId; s.sessions[id].sequence = snapshot.sequence; });
        if (latest.state !== "running") {
          const summary = snapshot.thread.messages.filter(m => m.role === "assistant" && m.turnId === latest.turnId).map(m => m.text).join("\n\n");
          const result = deliveryResult(summary);
          const pr = await this.options.pullRequests.find(session.route!, session.branch);
          if (!stillCurrent()) return;
          this.store.update(s => {
            const current = s.sessions[id];
            current.pr = pr ?? current.pr;
            delete current.active;
            const success = latest.state === "completed" && result.complete && pr?.state === "OPEN" && pr.isDraft;
            current.status = success ? (current.queue.length ? "queued" : "idle") : "paused";
            const prReport = pr ? `PR: ${pr.url} (${pr.state}, ${pr.isDraft ? "draft" : "not draft"})` : "No draft PR found; delivery is incomplete.";
            this.report(s, current, success ? "response" : "error", `${prReport}\n\n${result.body}${success ? "" : `\n\nT3Code turn ${latest.state}. Queued prompts are preserved and paused; send resume or cancel.`}`);
          });
        }
      } else if (snapshot.thread.session?.status === "error") {
        this.store.update(s => { const current = s.sessions[id]; current.status = "paused"; delete current.active; this.report(s, current, "error", "T3Code failed to start the turn. Queue paused; inspect T3Code, then resume or cancel."); });
      }
      return;
    }
    if (session.queue.length) {
      if (await this.checkPr(session)) return;
      if (!stillCurrent()) return;
      const issue = await this.options.linear.issue(session.issueId);
      const directory = path.resolve(this.options.worktreeRoot, "context", session.threadId);
      const context = await this.options.linear.context(issue, directory);
      const contextFile = path.join(directory, `${context.fingerprint}.json`);
      await writeFile(contextFile, context.text, { mode: 0o600 });
      const contextChange = session.contextFingerprint ? (session.contextFingerprint === context.fingerprint ? "Context unchanged." : "Context changed since the previous turn; read the refreshed material.") : "Initial context.";
      const contextText = context.text.length < 80_000 ? context.text : `Complete context (${context.text.length} characters) is supplied in ${contextFile}. Read this file in full before acting; no content was truncated.`;
      if (!stillCurrent()) return;
      const turn = session.queue[0];
      const requiredReading = /\b(?:must|required to)\s+(?:read|review|consult|access|fetch)|\brequired\s+(?:material|document|attachment|context|comments)/i.test(`${issue.description ?? ""}\n${turn.body}`);
      if (context.unavailable.length && requiredReading) {
        this.store.update(s => { const current = s.sessions[id]; current.status = "paused"; this.report(s, current, "elicitation", `Required source material is unavailable: ${context.unavailable.join(", ")}. Restore access or clarify the requirement, then send resume. No turn was submitted.`); });
        return;
      }
      let text = `${deliveryInstructions}\n\n${contextChange}\n${contextText}\n\n${turn.body}`;
      if (text.length > 100_000) {
        const turnFile = path.join(directory, `${turn.id}.txt`);
        await writeFile(turnFile, text, { mode: 0o600 });
        text = `${deliveryInstructions}\n\nRead the complete delegated turn at ${turnFile} before acting. Its context and follow-up exceed the transport input limit; the file preserves them in full.`;
      }
      if (!stillCurrent()) return;
      const command: RunnerCommand = {
        type: "thread.turn.start", commandId: randomUUID(), threadId: session.threadId,
        message: { messageId: turn.id, role: "user", text, attachments: [] },
        modelSelection: { instanceId: session.route!.provider, model: session.route!.model },
        runtimeMode: "full-access", interactionMode: "default", createdAt: new Date().toISOString(),
      };
      this.store.update(s => {
        const current = s.sessions[id];
        this.report(s, current, "thought", `${contextChange} Context inventory: ${context.inventory.filter(i => i.status === "supplied").length} supplied, ${context.inventory.filter(i => i.status === "externally delegated").length} externally delegated (not yet read), ${context.unavailable.length} unavailable.${context.unavailable.length ? ` Unavailable: ${context.unavailable.join(", ")}` : ""}`);
        current.contextFingerprint = context.fingerprint;
        current.command = command;
        current.active = { messageId: turn.id, previousTurnId: snapshot.thread.latestTurn?.turnId };
        current.queue.shift();
      });
      await this.options.runner.dispatch(command);
      if (!stillCurrent()) return;
      this.store.update(s => { delete s.sessions[id].command; });
    }
  }
}
