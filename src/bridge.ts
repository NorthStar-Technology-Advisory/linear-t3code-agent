import { Questions, nextQuestion, questionText, naturalAnswer, type Question, type Answers } from "./questions.js";
import { matchProject } from "./project-routing.js";
import { preparePublication, publishNext, type Publication, type ArtifactIdentities } from "./artifacts.js";
import { selectStatus, workflowGate, type Stage } from "./workflow.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { BridgeStore } from "./bridge-store.js";
import type { Runner, RunnerCommand, RunnerThread } from "./runner.js";
import { LinearClient, type IssueRevision } from "./linear-context.js";
import { LinearRateLimitError } from "./linear.js";
import { prepareCheckout, ticketBranch, git, type Route } from "./repository.js";
import { workflowInstructions, deliveryResult } from "./delivery.js";
import { cleanupWorktree, type PullRequests, type PullRequest } from "./pull-requests.js";
import { IntegrationError } from "./t3code-runner.js";
import { redact } from "./progress.js";
import { GitHubReviewSchema, GitHubMergeSchema, type GitHubReview, type GitHubMerge, type GitHubReviews } from "./github-review.js";
import { createHash } from "node:crypto";

const WebhookSchema = z.object({
  action: z.enum(["created", "prompted"]), organizationId: z.string().min(1),
  agentSession: z.object({ id: z.string().min(1), issue: z.object({ id: z.string().min(1) }).nullish() }),
  agentActivity: z.object({ id: z.string().optional(), signal: z.string().nullish(), content: z.object({ type: z.string().optional(), body: z.string().optional() }).optional() }).optional(),
  promptContext: z.string().optional(), guidance: z.array(z.object({ body: z.string().optional() }).passthrough()).nullish(),
});
type Webhook = z.infer<typeof WebhookSchema>;
type QueuedTurn = { id: string; body: string };
type PendingRequest = { id: string; kind: "approval" | "question"; description: string; response?: RunnerCommand; responseUnconfirmed?: boolean; responseMode?: string; questions?: Question[]; partialAnswers?: Answers; questionNumber?: number; };
type SavedThread = { threadId: string; created: boolean; sequence: number; seenActivities: string[] };
type Session = {
  id: string; workspaceId: string; issueId: string; teamId?: string; supersededBy?: string;
  artifactParentId?: string; questionCount?: number;
  publicationPreparationBlocked?: boolean;
  publication?: Publication; publicationHistory?: Publication[]; artifacts?: ArtifactIdentities;
  stage?: Stage; previousThreads?: SavedThread[];
  gate?: string; gateRevision?: number; gateDirty?: boolean; lastGateCheckAt?: number; nextStepAt?: number; transition?: boolean; retiredRequests?: string[];
  threadId: string; branch: string; worktree: string | null; route?: Route;
  status: "queued" | "running" | "paused" | "cancelled" | "cancelling" | "idle" | "closed";
  queue: QueuedTurn[]; command?: RunnerCommand;
  pendingProgress?: string; lastProgress?: string;
  pr?: PullRequest; lastPrCheckAt?: number; cleanup?: string;
  requests: PendingRequest[]; responses: RunnerCommand[];
  generation: number; cancelHadActive?: boolean; cancelCommand?: RunnerCommand; interrupted?: boolean; stopSent?: boolean;
  created: boolean; workspaceRequested?: boolean; bootstrapRecoveryPending?: boolean; active?: { issueRevisions?: Record<string, IssueRevision>; messageId: string; turnId?: string; previousTurnId?: string };
  sequence: number; seenActivities: string[]; createdAt: string; updatedAt: string;
  lastReportAt: number; lastError?: string; contextFingerprint?: string;
};
type Outbound = { issueId?: string; attempted?: boolean; id: string; sessionId: string; type: "thought" | "error" | "response" | "elicitation"; body: string };
type Undeliverable = Outbound & { failedAt: string; reason: "session archived" };
type QueuedGitHubReview = GitHubReview & { handoffIssued?: boolean };
type State = { workspaceId?: string; sessions: Record<string, Session>; deliveries: string[]; outbox: Outbound[]; undeliverable?: Undeliverable[]; githubReviews?: QueuedGitHubReview[]; githubMerges?: GitHubMerge[] };
export type BridgeOptions = {
  databasePath: string; worktreeRoot: string;
  pullRequests: PullRequests; prPollMs: number;
  githubReviews?: GitHubReviews;
  concurrency: number; runner: Runner; linear: LinearClient;
  pollMs: number; heartbeatMs: number; progressDebounceMs: number;
};

export class Bridge {
  private readonly store: BridgeStore<State>;
  private readonly deliveryRetryAt = new Map<string, number>();
  private readonly reviewRetryAt = new Map<number, number>();
  private readonly mergeRetryAt = new Map<string, number>();
  private ticking?: Promise<void>;
  private timer?: NodeJS.Timeout;
  constructor(private readonly options: BridgeOptions) {
    this.store = new BridgeStore(options.databasePath, { sessions: {}, deliveries: [], outbox: [] });
  }
  start() { this.timer ??= setInterval(() => { void this.tick().catch(() => console.error("bridge tick failed; check durable storage")); }, this.options.pollMs); }
  async close() { clearInterval(this.timer); await this.ticking; this.store.close(); }
  acceptGitHubReview(input: unknown, deliveryId: string): boolean {
    const parsed = GitHubReviewSchema.safeParse(input);
    if (!parsed.success || parsed.data.review.user.login !== "coderabbitai[bot]") return false;
    const event = parsed.data;
    return this.store.update(state => {
      const key = `github:${deliveryId}`;
      if (state.deliveries.includes(key)) return true;
      // An unrelated repository webhook cannot create a Linear handoff.
      if (!Object.values(state.sessions).some(session => session.branch === event.pull_request.head.ref && !session.supersededBy && session.status !== "closed")) return false;
      state.deliveries.push(key);
      (state.githubReviews ??= []).push(event);
      return true;
    });
  }
  acceptGitHubMerge(input: unknown, deliveryId: string): boolean {
    const parsed = GitHubMergeSchema.safeParse(input);
    if (!parsed.success) return false;
    const event = parsed.data;
    return this.store.update(state => {
      const key = `github:${deliveryId}`;
      if (state.deliveries.includes(key)) return true;
      if (!Object.values(state.sessions).some(session => session.branch === event.pull_request.head.ref && session.route)) return false;
      state.deliveries.push(key);
      (state.githubMerges ??= []).push(event);
      return true;
    });
  }
  accept(input: unknown): void {
    if (typeof input === "object" && input !== null && "type" in input && input.type === "Issue") {
      const event = z.object({ action: z.string(), organizationId: z.string(), data: z.object({ id: z.string(), updatedAt: z.string() }), updatedFrom: z.record(z.unknown()).optional() }).parse(input);
      if (event.action !== "update" || !event.updatedFrom || !("stateId" in event.updatedFrom || "delegateId" in event.updatedFrom)) return;
      this.store.update(state => {
        if (state.workspaceId && state.workspaceId !== event.organizationId) throw new Error("Workspace does not match this installation.");
        const key = `${event.organizationId}:issue:${event.data.id}:${event.data.updatedAt}:${JSON.stringify(event.updatedFrom)}`;
        if (state.deliveries.includes(key)) return;
        state.deliveries.push(key);
        for (const session of Object.values(state.sessions)) {
          if (session.issueId !== event.data.id || session.status === "closed" || session.supersededBy) continue;
          session.gateDirty = true;
          session.gateRevision = (session.gateRevision ?? 0) + 1;
        }
      });
      return;
    }
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
        for (const other of Object.values(state.sessions)) {
          if (other.issueId === payload.agentSession.issue.id && other.status !== "closed" && !other.supersededBy) {
            other.gateDirty = true;
            other.gateRevision = (other.gateRevision ?? 0) + 1;
          }
        }
        const threadId = randomUUID();
        const now = new Date().toISOString();
        session = state.sessions[id] = {
          id, workspaceId: payload.organizationId, issueId: payload.agentSession.issue.id,
          threadId, branch: `linear/${threadId}`, worktree: null,
          status: "queued", queue: [], created: false, generation: 0, requests: [], responses: [], sequence: 0, seenActivities: [],
          createdAt: now, updatedAt: now, lastReportAt: Date.now(),
        };
      }
      if (session.workspaceId !== payload.organizationId) throw new Error("Workspace does not match the existing session.");
      if (session.status === "closed") {
        this.report(state, session, "error", "This session has ended; resume cannot reopen it. If its PR closed or merged, create a new Linear ticket for further implementation.");
        return;
      }
      const body = payload.agentActivity?.content?.body?.trim().toLowerCase();
      if (payload.agentActivity?.signal === "stop" || ["stop", "cancel", "cancelled", "canceled"].includes(body ?? "")) {
        delete session.transition;
        this.requestCancellation(session);
        state.outbox = state.outbox.filter(o => o.sessionId !== id || o.issueId);
        return;
      }
      if (session.supersededBy) {
        this.report(state, session, "error", `This session was superseded by ${session.supersededBy}. Send feedback to the current issue session; this session cannot resume.`);
        return;
      }
      if (body === "resume" && session.status === "cancelling" && session.transition) {
        delete session.stopSent; delete session.cancelCommand;
        this.report(state, session, "thought", "Retrying provider stop for the stage transition. The next stage still waits for confirmed stop.");
        return;
      }
      if (body === "resume" && session.status === "paused") {
        delete session.publicationPreparationBlocked;
        session.status = "queued";
        if (session.bootstrapRecoveryPending) {
          if (session.command) delete session.command.bootstrap;
          delete session.bootstrapRecoveryPending;
        }
        delete session.lastError;
        if (!session.queue.length && !session.active) session.queue.push({ id: randomUUID(), body: "Resume the previous task, inspect its failure and complete the remaining work." });
        this.report(state, session, "thought", "Resuming preserved work and queued prompts.");
        return;
      }
      const reply = payload.agentActivity?.content?.body?.trim() ?? "";
      const explicit = /^(approve|decline|answer)\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(reply);
      const match = explicit && (explicit[1].toLowerCase() !== "answer" || session.requests.some(r => r.id === explicit[2]) || explicit[3]?.startsWith("{")) ? explicit : null;
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
        if ((!request.response || request.responseUnconfirmed) && !session.responses.some(r => r.requestId === request.id)) {
          request.responseUnconfirmed = false;
          session.responses.push(command);
        }
        return;
      }
      const pendingQuestion = session.requests.find(r => r.kind === "question" && nextQuestion(r));
      if (reply && pendingQuestion) {
        if ((pendingQuestion.response && !pendingQuestion.responseUnconfirmed) || session.responses.some(r => r.requestId === pendingQuestion.id)) {
          this.report(state, session, "thought", "Your answer has already been submitted. Waiting for the agent to continue.");
          return;
        }
        const question = nextQuestion(pendingQuestion)!;
        const answer = naturalAnswer(pendingQuestion, reply);
        if (answer === undefined) {
          this.report(state, session, "elicitation", `That choice does not match the current question.\n\n${questionText(pendingQuestion)}`);
          return;
        }
        pendingQuestion.partialAnswers = { ...pendingQuestion.partialAnswers, [question.id]: answer };
        if (nextQuestion(pendingQuestion)) {
          this.report(state, session, "elicitation", questionText(pendingQuestion));
        } else {
          const answers = pendingQuestion.partialAnswers;
          delete pendingQuestion.partialAnswers;
          pendingQuestion.responseUnconfirmed = false;
          session.responses.push({ type: "thread.user-input.respond", commandId: randomUUID(), threadId: session.threadId,
            requestId: pendingQuestion.id, answers, createdAt: new Date().toISOString() });
        }
        return;
      }
      if (session.status === "paused" && (session.publication?.blocked || session.publicationPreparationBlocked)) {
        if (session.publication) (session.publicationHistory ??= []).push(session.publication);
        delete session.publicationPreparationBlocked;
        delete session.publication; delete session.active; delete session.command;
        session.status = "queued";
        this.report(state, session, "thought", "Revising the blocked planning output using refreshed Linear artifacts and your feedback. Previous output and any prepared publication remain in history.");
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
  private async recoverAvailableSkills() {
    for (const session of Object.values(this.store.read().sessions)) {
      const skill = /^Workflow skill (\S+) is unavailable or ambiguous\b/.exec(session.lastError ?? "")?.[1];
      if (session.status !== "paused" || !skill || !session.route || !session.queue.length || (session.nextStepAt ?? 0) > Date.now()) continue;
      try {
        await this.options.runner.skill(skill, session.worktree ?? session.route.repository, session.route.modelSelection.instanceId);
        this.store.update(state => {
          const current = state.sessions[session.id];
          if (current.status !== "paused" || current.lastError !== session.lastError) return;
          current.status = "queued";
          delete current.lastError; delete current.nextStepAt;
          this.report(state, current, "thought", `Required T3Code skill ${skill} is available; resuming queued work.`);
        });
      } catch {
        this.store.update(state => {
          const current = state.sessions[session.id];
          if (current.status === "paused" && current.lastError === session.lastError) current.nextStepAt = Date.now() + 60_000;
        });
      }
    }
  }
  private async work() {
    await this.processGitHubMerges();
    await this.processGitHubReviews();
    const failedSessions = new Set<string>();
    for (const outgoing of this.store.read().outbox) {
      if (failedSessions.has(outgoing.sessionId)) continue;
      if ((this.deliveryRetryAt.get(outgoing.sessionId) ?? 0) > Date.now()) { failedSessions.add(outgoing.sessionId); continue; }
      try {
        if (!this.store.read().outbox.some(o => o.id === outgoing.id)) continue;
        this.store.update(s => { s.outbox.find(o => o.id === outgoing.id)!.attempted = true; });
        if (outgoing.issueId) await this.options.linear.comment(outgoing.issueId, redact(outgoing.body), outgoing.id);
        else await this.options.linear.activity(outgoing.sessionId, { type: outgoing.type, body: redact(outgoing.body) }, outgoing.id, outgoing.attempted);
        this.store.update(s => { s.outbox = s.outbox.filter(o => o.id !== outgoing.id); });
      } catch {
        const issueId = this.store.read().sessions[outgoing.sessionId]?.issueId;
        let archived = false;
        if (!outgoing.issueId && issueId) {
          try { archived = await this.options.linear.sessionArchived(issueId, outgoing.sessionId); }
          catch { /* Verification failed; retain the activity for retry. */ }
        }
        if (archived) {
          this.deliveryRetryAt.delete(outgoing.sessionId);
          this.store.update(state => {
            const retired = state.outbox.filter(item => item.sessionId === outgoing.sessionId && !item.issueId);
            (state.undeliverable ??= []).push(...retired.map(item => ({ ...item, failedAt: new Date().toISOString(), reason: "session archived" as const })));
            state.outbox = state.outbox.filter(item => !retired.some(entry => entry.id === item.id));
          });
          console.error("Linear session is archived; undelivered activities retained in the failure record", { agentSessionId: outgoing.sessionId });
        } else {
          this.deliveryRetryAt.set(outgoing.sessionId, Date.now() + 60_000);
          failedSessions.add(outgoing.sessionId);
          console.error("Linear activity delivery failed; update retained for retry", { agentSessionId: outgoing.sessionId, activityId: outgoing.id });
        }
      }
    }
    await this.recoverAvailableSkills();
    let running = Object.values(this.store.read().sessions).filter(s => (s.active || s.status === "running" || s.status === "cancelling")).length;
    const eligible: string[] = [];
    for (const session of Object.values(this.store.read().sessions)) {
      if (session.status !== "cancelling" && (session.nextStepAt ?? 0) > Date.now()) continue;
      if (session.status !== "closed" && session.gateDirty || session.status === "running" || session.status === "cancelling" || (session.status === "paused" && session.active)) eligible.push(session.id);
      else if (session.status === "queued" && (session.active || running < this.options.concurrency)) {
        this.store.update(s => { s.sessions[session.id].status = "running"; });
        if (!session.active) running++; eligible.push(session.id);
      } else if (session.pr && session.status !== "closed" && Date.now() - (session.lastPrCheckAt ?? 0) >= this.options.prPollMs) eligible.push(session.id);
    }
    await Promise.all(eligible.map(async id => {
      try {
        await this.step(id);
        if (this.session(id).nextStepAt) this.store.update(state => { delete state.sessions[id].nextStepAt; });
      }
      catch (error) {
        const message = redact(error instanceof Error ? error.message : "Bridge operation failed.");
        this.store.update(state => {
          const session = state.sessions[id];
          const changed = session.lastError !== message;
          if (changed) this.report(state, session, "error", message);
          session.lastError = message;
          if (error instanceof LinearRateLimitError) session.nextStepAt = Date.now() + 60_000;
          if (error instanceof IntegrationError && !error.retryable && session.status !== "cancelling") {
            if (session.status !== "paused" || changed) this.report(state, session, "error", "Integration requires attention. Work is preserved and paused; repair the configuration or adapter, then send resume.");
            if (session.publication) session.publication.blocked = true;
            session.status = "paused";
          }
        });
      }
    }));
  }
  private async processGitHubMerges() {
    if (!this.options.githubReviews) return;
    for (const event of this.store.read().githubMerges ?? []) {
      const key = `${event.repository.full_name}:${event.pull_request.number}`;
      if ((this.mergeRetryAt.get(key) ?? 0) > Date.now()) continue;
      try {
        const candidates = Object.values(this.store.read().sessions).filter(s => s.branch === event.pull_request.head.ref && s.route);
        const matches: Session[] = [];
        for (const candidate of candidates) {
          const pr = await this.options.pullRequests.find(candidate.route!, candidate.branch);
          if (pr?.url === event.pull_request.html_url && pr.number === event.pull_request.number && pr.state === "MERGED") matches.push(candidate);
        }
        if (new Set(matches.map(s => s.issueId)).size !== 1 || !matches.length) throw new Error("Merged PR does not map to one saved Linear issue.");
        const verified = await this.options.githubReviews.verifyMerge(event);
        if (!verified.merged || verified.url !== event.pull_request.html_url || verified.branch !== event.pull_request.head.ref) throw new Error("GitHub has not verified this PR as merged.");
        const session = matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
        const issue = await this.options.linear.issue(session.issueId);
        const doneIds = new Map<string, string>();
        const markDone = async (target: typeof issue) => {
          let doneId = doneIds.get(target.team.id);
          if (!doneId) {
            doneId = await this.options.linear.statusId(target.team.id, "Done");
            doneIds.set(target.team.id, doneId);
          }
          if (target.state.id !== doneId || target.delegate) await this.options.linear.updateMergedIssue(target.id, doneId);
          const saved = await this.options.linear.issue(target.id);
          if (saved.state.id !== doneId || saved.delegate) throw new Error(`Merged PR issue ${target.identifier} could not be verified as Done in Linear.`);
        };
        for (const childId of await this.options.linear.childIssueIds(issue.id)) {
          const child = await this.options.linear.issue(childId);
          if (child.parent?.id === issue.id) await markDone(child);
        }
        await markDone(issue);
        this.dropGitHubMerge(event);
      } catch (error) {
        this.mergeRetryAt.set(key, Date.now() + this.options.prPollMs);
        console.error("GitHub merge handoff retained for retry", { pullRequest: event.pull_request.html_url, message: redact(error instanceof Error ? error.message : String(error)) });
      }
    }
  }
  private dropGitHubMerge(event: GitHubMerge) {
    this.mergeRetryAt.delete(`${event.repository.full_name}:${event.pull_request.number}`);
    this.store.update(state => { state.githubMerges = (state.githubMerges ?? []).filter(item => !(item.repository.full_name === event.repository.full_name && item.pull_request.number === event.pull_request.number)); });
  }
  private async processGitHubReviews() {
    if (!this.options.githubReviews) return;
    for (const event of this.store.read().githubReviews ?? []) {
      if ((this.reviewRetryAt.get(event.review.id) ?? 0) > Date.now()) continue;
      try {
        const candidates = Object.values(this.store.read().sessions).filter(s => s.branch === event.pull_request.head.ref && !s.supersededBy && s.status !== "closed" && s.route);
        const matches: Session[] = [];
        for (const candidate of candidates) {
          const pr = await this.options.pullRequests.find(candidate.route!, candidate.branch);
          if (pr?.url === event.pull_request.html_url && pr.number === event.pull_request.number) matches.push(candidate);
        }
        if (matches.length !== 1) throw new Error("CodeRabbit PR does not map to one current ticket session.");
        const session = matches[0]!;
        const pr = await this.options.githubReviews.verify(event);
        if (!pr.open || pr.url !== event.pull_request.html_url || pr.branch !== session.branch || pr.head !== event.review.commit_id) {
          this.dropGitHubReview(event);
          continue;
        }
        const issue = await this.options.linear.issue(session.issueId);
        if (!issue.delegated || issue.state.name !== "Ready for review" || !issue.project?.id) {
          // The PR review may precede the final Linear status update.
          const targetName = event.review.state === "approved" ? "Ready for UAT" : "Ready for implementation";
          if ((event.handoffIssued && issue.state.name === targetName) || issue.state.name !== "Ready for implementation") this.dropGitHubReview(event);
          else this.reviewRetryAt.set(event.review.id, Date.now() + this.options.prPollMs);
          continue;
        }
        if (event.review.state === "approved" && !pr.checksPassing) {
          this.reviewRetryAt.set(event.review.id, Date.now() + this.options.prPollMs);
          continue;
        }
        const targetName = event.review.state === "approved" ? "Ready for UAT" : "Ready for implementation";
        const stateId = await this.options.linear.statusId(issue.team.id, targetName);
        if (!stateId) throw new Error(`Linear status ${targetName} is unavailable.`);
        const identity = createHash("sha256").update(`${event.repository.full_name}:${event.pull_request.number}:${event.review.id}`).digest("hex");
        const commentId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
        const note = `CodeRabbit ${event.review.state === "approved" ? "approved" : "requested changes"} on [PR #${event.pull_request.number}](${pr.url}) at commit \`${pr.head}\`. [Review findings](${event.review.html_url}).${event.review.body ? `\n\n${event.review.body.slice(0, 4000)}` : ""}\n\nProposed handoff: ${targetName}.`;
        await this.options.linear.comment(issue.id, note, commentId);
        const fresh = await this.options.linear.issue(issue.id);
        const latest = await this.options.githubReviews.verify(event);
        if (fresh.state.id !== issue.state.id || !fresh.delegated || latest.head !== pr.head || !latest.open) {
          this.dropGitHubReview(event);
          continue;
        }
        if (event.review.state === "approved" && !latest.checksPassing) {
          this.reviewRetryAt.set(event.review.id, Date.now() + this.options.prPollMs);
          continue;
        }
        this.store.update(state => { const queued = state.githubReviews?.find(item => item.review.id === event.review.id); if (queued) queued.handoffIssued = true; });
        await this.options.linear.updateReviewHandoff(issue.id, stateId, event.review.state === "approved");
        const saved = await this.options.linear.issue(issue.id);
        if (saved.state.id !== stateId || (event.review.state === "approved" && saved.delegate)) throw new Error("Linear review handoff could not be verified.");
        this.dropGitHubReview(event);
      } catch (error) {
        this.reviewRetryAt.set(event.review.id, Date.now() + this.options.prPollMs);
        console.error("GitHub review handoff retained for retry", { reviewId: event.review.id, message: redact(error instanceof Error ? error.message : String(error)) });
      }
    }
  }
  private dropGitHubReview(event: GitHubReview) {
    this.reviewRetryAt.delete(event.review.id);
    this.store.update(state => { state.githubReviews = (state.githubReviews ?? []).filter(item => item !== event && !(item.repository.full_name === event.repository.full_name && item.pull_request.number === event.pull_request.number && item.review.id === event.review.id)); });
  }
  private requestCancellation(session: Session) {
    if (session.publication) { (session.publicationHistory ??= []).push(session.publication); delete session.publication; }
    delete session.publicationPreparationBlocked;
    session.retiredRequests = [...(session.retiredRequests ?? []), ...session.requests.map(r => r.id)];
    session.generation++;
    session.cancelHadActive = Boolean(session.active);
    session.status = "cancelling";
    session.queue = []; session.requests = []; session.responses = [];
    delete session.cancelCommand; delete session.interrupted; delete session.stopSent;
  }
  private async reconcileWorkspace(session: Session, thread: RunnerThread): Promise<Session> {
    if (session.route?.workspaceMode !== "worktree" || session.worktree || !thread.worktreePath || !session.workspaceRequested) return session;
    const workspace = await realpath(thread.worktreePath);
    const entries = (await git(session.route.repository, "worktree", "list", "--porcelain")).split("\n\n");
    const registered = entries.some(entry => entry.split("\n").includes(`worktree ${workspace}`) && entry.split("\n").includes(`branch refs/heads/${session.branch}`));
    if (thread.projectId !== session.route.t3ProjectId || thread.branch !== session.branch || workspace === await realpath(session.route.repository) || !registered) throw new IntegrationError("T3Code bootstrap returned an unexpected workspace; inspect the thread before resuming.", false);
    this.store.update(s => { if (s.sessions[session.id].generation === session.generation) s.sessions[session.id].worktree = thread.worktreePath; });
    return this.session(session.id);
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
    try { cleanup = session.route.workspaceMode === "local" ? "Current checkout files and branch preserved; reservation released." : session.worktree ? await cleanupWorktree(session.route, session.worktree) : "No verified worktree path; files preserved for manual inspection."; }
    catch { cleanup = "Worktree preserved: cleanup could not verify clean, fully pushed state. Check git access before manual cleanup."; }
    if (this.session(session.id).generation !== session.generation) return true;
    this.store.update(s => {
      const current = s.sessions[session.id]; current.status = "closed"; current.queue = []; current.cleanup = cleanup;
      this.report(s, current, "error", `PR ${pr.url} is ${pr.state.toLowerCase()}. Create a new Linear ticket for further implementation.\n${cleanup}`);
    });
    return true;
  }
  private observe(id: string, thread: RunnerThread, sequence: number, reconciled = false) {
    this.store.update(state => {
      const session = state.sessions[id];
      const reformatted = new Set<string>();
      // Upgrade saved pending questions from the earlier raw-JSON presentation.
      for (const request of session.requests) {
        if (request.kind !== "question" || request.questionNumber !== undefined) continue;
        try {
          const questions = Questions.safeParse(JSON.parse(request.description).questions);
          if (questions.success) request.questions = questions.data;
        } catch { /* A readable description needs no payload migration. */ }
        request.questionNumber = (session.questionCount ?? 0) + 1;
        session.questionCount = request.questionNumber + (request.questions?.length ?? 1) - 1;
        reformatted.add(request.id);
      }
      const previousRequests = new Map(session.requests.map(r => [r.id, r]));
      if (reconciled) session.requests = [];
      const newActivities = thread.activities.filter(a => !session.seenActivities.includes(a.id));
      for (const activity of reconciled ? thread.activities : newActivities) {
        if (session.retiredRequests?.includes(String(activity.payload?.requestId))) continue;
        if (!session.seenActivities.includes(activity.id)) session.seenActivities.push(activity.id);
        const requestId = activity.payload?.requestId;
        if (typeof requestId === "string" && /^(approval|user-input)\.resolved$/.test(activity.kind)) {
          session.requests = session.requests.filter(r => r.id !== requestId);
        }
        if (typeof requestId === "string" && /^(approval|user-input)\.requested$/.test(activity.kind)) {
          const questions = Questions.safeParse(activity.payload?.questions);
          let questionNumber = previousRequests.get(requestId)?.questionNumber;
          if (questionNumber === undefined && questions.success) {
            questionNumber = (session.questionCount ?? 0) + 1;
            session.questionCount = questionNumber + questions.data.length - 1;
          }
          const request: PendingRequest = {
            questionNumber, id: requestId, kind: activity.kind === "approval.requested" ? "approval" : "question",
            description: typeof activity.payload?.detail === "string" ? activity.payload.detail : activity.summary, partialAnswers: previousRequests.get(requestId)?.partialAnswers, response: previousRequests.get(requestId)?.response, responseUnconfirmed: previousRequests.get(requestId)?.responseUnconfirmed, responseMode: typeof activity.payload?.responseMode === "string" ? activity.payload.responseMode : undefined, questions: questions.success ? questions.data : undefined,
          };
          session.requests = session.requests.filter(r => r.id !== request.id);
          session.requests.push(request);
        }
      }
      for (const activity of newActivities) {
        if (!/^provider\.(approval|user-input)\.respond\.failed$/.test(activity.kind)) continue;
        const request = session.requests.find(r => r.id === activity.payload?.requestId);
        if (!request) continue;
        delete request.response; delete request.responseUnconfirmed;
        session.responses = session.responses.filter(r => r.requestId !== request.id);
        this.report(state, session, "elicitation", request.kind === "question" ? `T3Code could not accept your answer. Please reply again.\n\n${questionText(request)}` : `T3Code provider response failed for request ${request.id}. The request remains pending. Check T3Code, then send a corrected explicit answer or approval; unrelated prompts remain queued.`);
      }
      if (reconciled) {
        for (const request of session.requests) {
          if (!request.response || request.responseUnconfirmed || session.responses.some(r => r.requestId === request.id)) continue;
          request.responseUnconfirmed = true;
          this.report(state, session, "elicitation", request.kind === "question" ? `T3Code still needs an answer after reconnecting; the previous response could not be confirmed. Please reply again if you want to retry.\n\n${questionText(request)}` : `T3Code still lists request ${request.id} as pending after a gap in event history. The prior response outcome is unknown. No response was resent. Inspect the request, then send a new explicit answer or approval if it should be retried.`);
        }
      }
      // Only elicit requests still pending after replaying the whole snapshot.
      for (const request of session.requests) {
        const becameCurrent = request.kind === "question" && session.requests.find(r => r.kind === "question")?.id === request.id
          && [...previousRequests.values()].find(r => r.kind === "question")?.id !== request.id;
        if (!becameCurrent && !reformatted.has(request.id) && !(reconciled && !previousRequests.has(request.id)) && !newActivities.some(a => a.payload?.requestId === request.id && a.kind.endsWith(".requested"))) continue;
        if (request.kind === "question") {
          if (session.requests.find(r => r.kind === "question")?.id === request.id) this.report(state, session, "elicitation", questionText(request));
        } else this.report(state, session, "elicitation", `${request.description}\n\nReply exactly: approve ${request.id} OR decline ${request.id}.`);
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
    if (snapshot?.thread.session && snapshot.thread.session.status !== "stopped") {
      const replay = await this.options.runner.replay(session.threadId, session.sequence);
      if (this.session(session.id).generation !== session.generation) return;
      const activities = [...snapshot.thread.activities, ...(replay.snapshot?.thread.activities ?? []), ...replay.events.map(event => event.activity)];
      this.store.update(state => {
        const current = state.sessions[session.id];
        for (const activity of activities) {
          if (activity.kind !== "provider.session.stop.failed" || current.seenActivities.includes(activity.id)) continue;
          current.seenActivities.push(activity.id);
          this.report(state, current, "error", "T3Code provider stop failed. Work is still treated as active and later prompts remain queued. Check T3Code, then send cancel to retry stopping; no replacement coding turn will start before provider stop is confirmed.");
        }
        current.sequence = Math.max(current.sequence, snapshot.sequence, replay.snapshot?.sequence ?? 0);
      });
      return;
    }
    if (snapshot) {
      const generation = session.generation;
      try { session = await this.reconcileWorkspace(session, snapshot.thread); }
      catch {
        this.store.update(s => this.report(s, s.sessions[session.id], "error", "Provider stopped, but the worktree identity could not be verified. Files are preserved; inspect and restore the T3Code workspace before resuming."));
      }
      if (this.session(session.id).generation !== generation) return;
    }
    this.store.update(s => {
      const current = s.sessions[session.id];
      if (current.transition) {
        if (snapshot) {
          current.seenActivities = [...new Set([...current.seenActivities, ...snapshot.thread.activities.map(a => a.id)])];
          current.retiredRequests = [...new Set([...(current.retiredRequests ?? []), ...snapshot.thread.activities.flatMap(a => typeof a.payload?.requestId === "string" ? [a.payload.requestId] : [])])];
        }
        delete current.stage;
        current.status = "queued";
        current.queue = [{ id: randomUUID(), body: "Execute the stage selected by the current Linear status. Read refreshed artifacts and reconcile existing work before proceeding." }];
        current.created = Boolean(snapshot);
        delete current.active; delete current.command; delete current.cancelCommand; delete current.interrupted; delete current.stopSent; delete current.transition;
        this.report(s, current, "thought", "Previous stage stopped. Its questions and queued replies are inactive; conversation, artifacts, branch and files are preserved. Rechecking current status and delegation before the next stage.");
        return;
      }
      const ended = Boolean(current.supersededBy) || current.route?.workspaceMode === "local";
      current.status = ended ? "closed" : current.queue.length ? "queued" : "cancelled";
      if (ended) current.queue = [];
      if (current.command?.bootstrap && current.worktree && !snapshot?.thread.messages.some(m => m.id === current.active?.messageId)) current.bootstrapRecoveryPending = true;
      current.created = Boolean(snapshot);
      delete current.active; delete current.command; delete current.cancelCommand; delete current.interrupted; delete current.stopSent;
      const outcome = current.supersededBy ? `This session was superseded by ${current.supersededBy}; provider stop is confirmed.` : current.cancelHadActive ? "T3Code provider stopped by user." : "No active coding turn remained; any T3Code provider session is stopped.";
      delete current.cancelHadActive;
      this.report(s, current, "error", `${outcome}${ended && !current.supersededBy ? " This current-checkout session has ended and its reservation is released. Start a new delegation for further work; resume cannot reopen it." : ""} Pending prompts cleared; thread, branch, worktree, changes and any PR are preserved. Descendant-process cleanup is delegated to T3Code.`);
    });
  }
  private async step(id: string) {
    let session = this.session(id);
    if (session.status === "cancelling") { await this.cancel(session); return; }
    if (session.supersededBy || session.status === "closed") return;
    if (session.pr && Date.now() - (session.lastPrCheckAt ?? 0) >= this.options.prPollMs) {
      if (await this.checkPr(session)) return;
    }
    const generation = session.generation;
    const gateRevision = session.gateRevision ?? 0;
    const stillCurrent = () => this.session(id).generation === generation && (this.session(id).gateRevision ?? 0) === gateRevision;
    // Webhooks invalidate the gate immediately. During an unchanged active turn,
    // keep observing T3Code without rereading Linear on every one-second tick.
    const reuseGate = Boolean(session.active && session.stage && session.route && session.created && session.gate &&
      !session.gateDirty && !session.command && !session.responses.length && !session.publication &&
      Date.now() - (session.lastGateCheckAt ?? 0) < 60_000);
    let gateIssue!: Awaited<ReturnType<LinearClient["issue"]>>;
    let gate = session.gate ?? "";
    if (!reuseGate) {
    const owner = await this.options.linear.currentSession(session.issueId);
    if (!stillCurrent()) return;
    this.store.update(state => {
      for (const other of Object.values(state.sessions)) {
        if (other.issueId !== session.issueId || other.id === owner || other.status === "closed" || other.supersededBy) continue;
        other.supersededBy = owner;
        delete other.transition; delete other.gateDirty;
        this.requestCancellation(other);
        state.outbox = state.outbox.filter(o => o.sessionId !== other.id || o.issueId);
      }
    });
    if (owner !== id || !stillCurrent()) return;
    if (Object.values(this.store.read().sessions).some(other => other.issueId === session.issueId && other.supersededBy && other.status !== "closed")) return;
    if (!session.artifacts) {
      // Ownership is settled and all predecessors have stopped before copying their ledger.
      this.store.update(state => {
        const predecessor = Object.values(state.sessions)
          .filter(other => other.id !== id && other.issueId === session.issueId && other.artifacts)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        state.sessions[id].artifacts = structuredClone(predecessor?.artifacts ?? { children: {}, relations: {} });
        state.sessions[id].questionCount = predecessor?.questionCount ?? 0;
      });
      session = this.session(id);
    }
    gateIssue = await this.options.linear.issue(session.issueId);
    if (!stillCurrent()) return;
    gate = workflowGate(gateIssue);
    this.store.update(s => { s.sessions[id].gateDirty = false; s.sessions[id].lastGateCheckAt = Date.now(); });
    if ((session.gate !== undefined && session.gate !== gate) || (session.gate === undefined && session.created && !session.stage)) {
      if (session.stage?.output === "external-review") {
        this.store.update(s => {
          const current = s.sessions[id];
          current.gate = gate;
          delete current.stage;
          current.queue = gateIssue.delegated ? [{ id: randomUUID(), body: "Enter the stage selected by the current Linear status." }] : [];
          current.status = gateIssue.delegated ? "queued" : "idle";
        });
        return;
      }
      this.store.update(s => {
        const current = s.sessions[id];
        current.gate = gate;
        this.requestCancellation(current);
        current.transition = true;
        s.outbox = s.outbox.filter(o => o.sessionId !== id || o.issueId);
      });
      return;
    }
    this.store.update(s => { s.sessions[id].gate = gate; });
    // Existing invocations retain their configuration; edits take effect on the next entry.
    const projectConfig = gateIssue.delegated && !session.stage
      ? await this.options.linear.projectConfig(gateIssue.project?.id) : undefined;
    if (!stillCurrent()) return;
    const selectedStatus = projectConfig ? selectStatus(gateIssue, projectConfig) : undefined;
    if (!gateIssue.delegated || (!session.stage && !selectedStatus)) {
      this.store.update(s => { s.sessions[id].status = "idle"; s.sessions[id].queue = []; });
      return;
    }
    if (session.stage?.output === "external-review") {
      this.store.update(s => { s.sessions[id].status = "idle"; s.sessions[id].queue = []; });
      return;
    }
    if (session.status !== "running" && !(session.status === "paused" && session.active)) return;
    if (session.stage && !session.stage.output) throw new IntegrationError("This session uses the previous workflow configuration. Cancel it and start a new delegation after adding project YAML.", false);

    if (!session.route) {
      // Session history is the durable ticket-workspace ledger. Only transfer it
      // after every previous provider has stopped (the ownership gate above).
      let predecessor = Object.values(this.store.read().sessions).reverse()
        .filter(other => other.id !== id && other.workspaceId === session.workspaceId && other.issueId === session.issueId && other.route)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (predecessor) {
        if (predecessor.cleanup || (predecessor.pr && predecessor.pr.state !== "OPEN")) throw new IntegrationError("This ticket's PR has closed or merged. Its workspace is retired; create a new Linear ticket for further work.", false);
        if (predecessor.route!.workspaceMode !== "worktree") throw new IntegrationError("This ticket uses a legacy current checkout. Preserve its changes and finish it before starting a new ticket with an isolated worktree.", false);
        if (predecessor.workspaceRequested && !predecessor.worktree) {
          const snapshot = await this.options.runner.snapshot(predecessor.threadId);
          if (snapshot) predecessor = await this.reconcileWorkspace(predecessor, snapshot.thread);
        }
        if (predecessor.workspaceRequested && !predecessor.worktree) throw new IntegrationError("The previous session requested a worktree but its path is unverified. Reconcile its T3Code workspace before retrying; no replacement workspace was created.", false);
        if (predecessor.worktree) {
          let root: string;
          try { root = await realpath(predecessor.worktree); }
          catch { throw new IntegrationError("The ticket worktree is missing. Restore it before resuming; no replacement workspace was created.", false); }
          const entries = (await git(predecessor.route!.repository, "worktree", "list", "--porcelain")).split("\n\n");
          if (!entries.some(entry => entry.split("\n").includes(`worktree ${root}`) && entry.split("\n").includes(`branch refs/heads/${predecessor.branch}`))) throw new IntegrationError("The ticket worktree is missing or its branch changed. Restore it before resuming.", false);
        }
        if (!stillCurrent()) return;
        this.store.update(s => Object.assign(s.sessions[id], {
          route: structuredClone(predecessor.route), branch: predecessor.branch,
          worktree: predecessor.worktree, pr: predecessor.pr, teamId: gateIssue.team.id,
          bootstrapRecoveryPending: predecessor.bootstrapRecoveryPending,
          ...(selectedStatus?.output === "external-review" ? { threadId: predecessor.threadId, created: predecessor.created,
            sequence: predecessor.sequence, seenActivities: [...predecessor.seenActivities] } : {}),
        }));
        session = this.session(id);
      }
    }
    if (!session.route) {
      if (selectedStatus?.output === "external-review") throw new IntegrationError("Ready for review requires an existing implementation thread and ticket branch; no coding session was started.", false);
      let route: Route;
      try {
        const title = projectConfig!.project;
        const project = await matchProject(await this.options.runner.projects(), title);
        const execution = await this.options.runner.execution(project);
        route = { repository: await realpath(project.workspaceRoot), t3ProjectId: project.id, ...execution, workspaceMode: "worktree", baseBranch: "" };
        if (route.workspaceMode === "worktree") route.baseBranch = await this.options.runner.baseBranch(route.repository);
      } catch (error) { throw new IntegrationError(error instanceof Error ? error.message : "Project resolution failed; correct T3Code settings and send resume.", false); }
      const branch = ticketBranch(gateIssue.identifier, gateIssue.title);
      if (await git(route.repository, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`)) throw new IntegrationError(`Branch ${branch} already exists without a saved ticket workspace. Reconcile the existing branch before resuming; files were preserved.`, false);
      if (!stillCurrent()) return;
      this.store.update(s => {
        s.sessions[id].branch = branch;
        s.sessions[id].route = route; s.sessions[id].teamId = gateIssue.team.id;
      });
      session = this.session(id);
    }
    if (!session.stage && selectedStatus?.output === "external-review") {
      if (!session.created) throw new IntegrationError("Ready for review requires an existing implementation thread; no coding session was started.", false);
      this.store.update(s => {
        const current = s.sessions[id];
        current.stage = { id: randomUUID(), output: "external-review", statusId: gateIssue.state.id, teamId: gateIssue.team.id,
          prompt: selectedStatus.prompt, instructions: projectConfig!.instructions, skills: [] };
        current.queue = [];
        current.status = "idle";
      });
      return;
    }
    if (!session.stage) {
      const settings = selectedStatus!;
      const skills: Stage["skills"] = [];
      for (const name of settings["required-skills"]) {
        skills.push({ name, path: await this.options.runner.skill(name, session.worktree ?? session.route!.repository, session.route!.modelSelection.instanceId) });
      }
      if (!stillCurrent()) return;
      this.store.update(s => {
        const current = s.sessions[id];
        if (settings["new-thread"] && current.created) {
          (current.previousThreads ??= []).push({ threadId: current.threadId, created: current.created, sequence: current.sequence, seenActivities: current.seenActivities });
          Object.assign(current, { threadId: randomUUID(), created: false, sequence: 0, seenActivities: [] });
        }
        current.artifactParentId = gateIssue.parent?.id ?? gateIssue.id;
        current.stage = { id: randomUUID(), output: settings.output, statusId: gateIssue.state.id, teamId: gateIssue.team.id,
          prompt: settings.prompt, instructions: projectConfig!.instructions, skills };
      });
      session = this.session(id);
    }
    }
    if (!session.created) {
      try {
        if (session.route!.workspaceMode === "local") await prepareCheckout(session.route!, session.branch);
      } catch (error) { throw new IntegrationError(`${error instanceof Error ? error.message : "Workspace preparation failed."} Files preserved; correct Git state and send resume.`, false); }
      if (!stillCurrent()) return;
      if (!session.command && (!gateIssue.project?.name || !gateIssue.state?.name)) throw new IntegrationError("Linear project or issue status name is unavailable; restore access and resume.", false);
      const command: RunnerCommand = session.command ?? {
        type: "thread.create", commandId: randomUUID(), threadId: session.threadId,
        projectId: session.route!.t3ProjectId, title: `${gateIssue.project!.name}: ${gateIssue.title} - ${gateIssue.state.name}`,
        modelSelection: session.route!.modelSelection,
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
    if (session.route!.workspaceMode === "local" && await git(session.route!.repository, "branch", "--show-current") !== session.branch) {
      throw new IntegrationError("Current checkout is no longer on the session branch. Restore its branch in Git and send resume; files are preserved.", false);
    }
    let snapshot = await this.options.runner.snapshot(session.threadId);
    if (!stillCurrent()) return;
    if (!snapshot) throw new Error("T3Code thread is missing; restore it before resuming this session.");
    session = await this.reconcileWorkspace(session, snapshot.thread);
    if (!stillCurrent()) return;
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
    const paused = session.status === "paused";
    if (!paused && session.responses.length) {
      const response = session.responses[0];
      try {
        if (session.requests.some(r => r.id === response.requestId)) await this.options.runner.dispatch(response);
      } catch (error) {
        if (!stillCurrent()) return;
        if (!(error instanceof IntegrationError) || error.retryable) throw error;
        this.store.update(s => {
          s.sessions[id].responses.shift();
          const request = s.sessions[id].requests.find(r => r.id === response.requestId);
          if (request?.response) request.responseUnconfirmed = true;
          this.report(s, s.sessions[id], "elicitation", request?.kind === "question" ? `T3Code rejected your answer. Check the request and reply again; no replacement was submitted automatically.\n\n${questionText(request)}` : `T3Code rejected the response for ${String(response.requestId)}. Check the request and credentials, then send a corrected explicit response. No replacement was submitted automatically.`);
        });
        return;
      }
      if (!stillCurrent()) return;
      this.store.update(s => {
        const current = s.sessions[id]; current.responses.shift();
        const request = current.requests.find(r => r.id === response.requestId);
        if (request) { request.response = response; request.responseUnconfirmed = false; }
      });
      return;
    }
    if (!paused && session.command) {
      // A lost acknowledgement is reconciled against the user message first. If absent,
      // T3Code's durable command receipts make replay of the SAME command id safe.
      if (!snapshot.thread.messages.some(m => m.id === session.active?.messageId)) {
        if (session.worktree && session.command.bootstrap) {
          this.store.update(s => {
            const current = s.sessions[id]; current.bootstrapRecoveryPending = true; current.status = "paused";
            this.report(s, current, "error", "T3Code prepared the worktree, but setup and the first turn are unconfirmed. Inspect the setup in T3Code and complete or repair it, then send resume. The prepared workspace is preserved; neither setup nor coding will be retried automatically.");
          });
          return;
        }
        await this.options.runner.dispatch(session.command);
      }
      if (!stillCurrent()) return;
      this.store.update(s => { delete s.sessions[id].command; });
      return;
    }
    if (session.publication) {
      if (paused) return;
      const adoptedRelationId = await publishNext(this.options.linear, session.publication, stillCurrent);
      if (!stillCurrent()) return;
      this.store.update(s => {
        const current = s.sessions[id];
        const publication = current.publication!;
        const operation = publication.operations[publication.cursor];
        for (const [key, relationId] of Object.entries(current.artifacts?.relations ?? {})) {
          if (relationId !== operation.id) continue;
          if (operation.kind === "removeRelation") delete current.artifacts!.relations[key];
          else if (adoptedRelationId) current.artifacts!.relations[key] = adoptedRelationId;
        }
        publication.cursor++;
        if (publication.cursor >= publication.operations.length) {
          (current.publicationHistory ??= []).push(publication);
          delete current.publication; delete current.active; delete current.command;
          current.status = current.queue.length ? "queued" : "idle";
          this.report(s, current, "response", `${publication.report}\n\nLinear artifacts published. ${publication.review.join("\n")}\nWaiting for human direction; status unchanged.`);
        }
      });
      return;
    }
    if (session.active) {
      if (session.requests.length) return;
      const latest = snapshot.thread.latestTurn;
      if (latest && latest.turnId !== session.active.previousTurnId) {
        this.store.update(s => { s.sessions[id].active!.turnId = latest.turnId; s.sessions[id].sequence = snapshot.sequence; });
        if (latest.state !== "running") {
          const summary = snapshot.thread.messages.filter(m => m.role === "assistant" && m.turnId === latest.turnId).map(m => m.text).join("\n\n");
          if (session.stage!.output === "agent-managed") {
            const readable = summary.replace(/<bridge-result>[\s\S]*?<\/bridge-result>/g, "").trim();
            const excerpt = readable.length > 2_000 ? `${readable.slice(0, 2_000)}\n\nFull response is in the T3Code thread.` : readable;
            this.store.update(s => {
              const current = s.sessions[id];
              delete current.active; delete current.command;
              current.status = latest.state === "completed" && !paused ? (current.queue.length ? "queued" : "idle") : "paused";
              this.report(s, current, latest.state === "completed" ? "response" : "error", excerpt || `T3Code turn ${latest.state}.`);
            });
            return;
          }
          const planning = session.stage!.output !== "draft-pr";
          const result = deliveryResult(summary, session.stage!.output);
          if (planning && result.complete && latest.state === "completed") {
            if (paused) return;
            const issue = await this.options.linear.issue(session.issueId);
            let prepared: Awaited<ReturnType<typeof preparePublication>>;
            try {
              prepared = await preparePublication(this.options.linear, issue, session.stage!.id, result.artifacts, result.summary!, result.body, session.artifacts ?? { children: {}, relations: {} }, session.active.issueRevisions);
            } catch (error) {
              if (!stillCurrent()) return;
              if (error instanceof IntegrationError && !error.retryable) this.store.update(s => {
                const current = s.sessions[id];
                current.publicationPreparationBlocked = true;
                delete current.active;
              });
              throw error;
            }
            if (!stillCurrent()) return;
            this.store.update(s => { s.sessions[id].publication = prepared.publication; s.sessions[id].artifacts = prepared.identities; });
            return;
          }
          const pr = planning ? null : await this.options.pullRequests.find(session.route!, session.branch);
          if (!stillCurrent()) return;
          this.store.update(s => {
            const current = s.sessions[id];
            current.pr = pr ?? current.pr;
            delete current.active;
            const success = latest.state === "completed" && result.complete && !planning && pr?.state === "OPEN" && pr.isDraft;
            current.status = success && !paused ? (current.queue.length ? "queued" : "idle") : "paused";
            delete current.command;
            const prReport = planning ? "Planning output has not been published; the stage is incomplete." : pr ? `PR: ${pr.url} (${pr.state}, ${pr.isDraft ? "draft" : "not draft"})` : "No draft PR found; delivery is incomplete.";
            this.report(s, current, success ? "response" : "error", `${prReport}\n\n${result.body}${success && paused ? "\n\nQueued prompts remain paused after an integration failure; send resume or cancel." : success ? "" : `\n\nT3Code turn ${latest.state}. Queued prompts are preserved and paused; send resume or cancel.`}`);
          });
        }
      } else if (snapshot.thread.session?.status === "error") {
        this.store.update(s => { const current = s.sessions[id]; current.status = "paused"; delete current.active; this.report(s, current, "error", "T3Code failed to start the turn. Queue paused; inspect T3Code, then resume or cancel."); });
      }
      return;
    }
    if (!paused && session.queue.length) {
      if (session.bootstrapRecoveryPending) {
        this.store.update(s => { s.sessions[id].status = "paused"; this.report(s, s.sessions[id], "error", "Worktree setup remains unconfirmed. Inspect and complete or repair setup in T3Code, then send resume."); });
        return;
      }
      if (session.stage?.output === "draft-pr" && await this.checkPr(session)) return;
      if (!stillCurrent()) return;
      const issue = await this.options.linear.issue(session.issueId);
      const directory = path.resolve(this.options.worktreeRoot, "context", session.threadId);
      const context = await this.options.linear.context(issue, directory);
      if (session.stage!.output !== "comment" && issue.parent) {
        const parent = await this.options.linear.issue(issue.parent.id);
        if (!parent.description?.trim() || context.unavailable.some(source => source === `Linear issue ${parent.id}` || source === `${parent.url}#comments` || source === `${parent.url}#children` || source === `${parent.url}#relations` || source === `${parent.url}#inverseRelations`)) throw new IntegrationError("Required parent specification or decision/dependency context is unavailable. Restore access and send resume.", false);
      }
      if (session.stage!.output === "tickets" && !issue.description?.trim()) throw new IntegrationError("A parent specification is required before ticket creation. Publish/review the specification and send resume.", false);
      const contextFile = path.join(directory, `${context.fingerprint}.json`);
      await writeFile(contextFile, context.text, { mode: 0o600 });
      const contextChange = session.contextFingerprint ? (session.contextFingerprint === context.fingerprint ? "Context unchanged." : "Context changed since the previous turn; read the refreshed material.") : "Initial context.";
      const contextText = context.text.length < 80_000 ? context.text : `Complete context (${context.text.length} characters) is supplied in ${contextFile}. Read this file in full before acting; no content was truncated.`;
      if (!stillCurrent()) return;
      const turn = session.queue[0];
      const instructions = `${workflowInstructions(session.stage!)}\nRetained artifact identities: ${JSON.stringify(session.artifacts ?? { children: {}, relations: {} })}`;
      let text = `${instructions}\n\n${contextChange}\n${contextText}\n\n${turn.body}`;
      if (text.length > 100_000) {
        const turnFile = path.join(directory, `${turn.id}.txt`);
        await writeFile(turnFile, text, { mode: 0o600 });
        text = `Read the complete delegated turn at ${turnFile} before acting. The file preserves the bridge instructions, configured status prompt, context and follow-up in full; they exceed the transport input limit.`;
      }
      if (!stillCurrent()) return;
      const launchIssue = await this.options.linear.issue(session.issueId);
      if (!stillCurrent()) return;
      if (workflowGate(launchIssue) !== gate || await this.options.linear.currentSession(session.issueId) !== id) {
        this.store.update(s => { s.sessions[id].gateDirty = true; });
        return;
      }
      if (!stillCurrent()) return;
      const command: RunnerCommand = {
        type: "thread.turn.start", commandId: randomUUID(), threadId: session.threadId,
        message: { messageId: turn.id, role: "user", text, attachments: [] },
        modelSelection: session.route!.modelSelection,
        runtimeMode: "full-access", interactionMode: "default", createdAt: new Date().toISOString(),
        ...(session.route!.workspaceMode === "worktree" && !session.worktree ? { bootstrap: {
          prepareWorktree: { projectCwd: session.route!.repository, baseBranch: session.route!.baseBranch, branch: session.branch, startFromOrigin: session.route!.startFromOrigin }, runSetupScript: true,
        } } : {}),
      };
      this.store.update(s => {
        const current = s.sessions[id];
        this.report(s, current, "thought", `${contextChange} Context inventory: ${context.inventory.filter(i => i.status === "supplied").length} supplied, ${context.inventory.filter(i => i.status === "externally delegated").length} externally delegated (not yet read), ${context.unavailable.length} unavailable.${context.unavailable.length ? ` Unavailable: ${context.unavailable.join(", ")}` : ""}`);
        current.contextFingerprint = context.fingerprint;
        current.command = command;
        if (command.bootstrap) current.workspaceRequested = true;
        current.active = { issueRevisions: context.issueRevisions, messageId: turn.id, previousTurnId: snapshot.thread.latestTurn?.turnId };
        current.queue.shift();
      });
      await this.options.runner.dispatch(command);
      if (!stillCurrent()) return;
      this.store.update(s => { delete s.sessions[id].command; });
    }
  }
}
