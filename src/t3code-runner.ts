import { registerSecrets } from "./secrets.js";
import { z } from "zod";
import type { Runner, RunnerCommand, RunnerThread, RunnerActivity, ReplayResult } from "./runner.js";

const ThreadSchema = z.object({
  id: z.string(), projectId: z.string(), branch: z.string().nullable(), worktreePath: z.string().nullable(),
  messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string(), turnId: z.string().nullable(), streaming: z.boolean().optional() })),
  activities: z.array(z.object({ id: z.string(), kind: z.string(), summary: z.string(), tone: z.string(), turnId: z.string().nullable(), sequence: z.number().optional(), createdAt: z.string().optional(), payload: z.record(z.unknown()).nullable() })),
  latestTurn: z.object({ turnId: z.string(), state: z.enum(["running", "completed", "interrupted", "error"]), assistantMessageId: z.string().nullable().optional() }).nullable(),
  session: z.object({ status: z.string(), lastError: z.string().nullable(), activeTurnId: z.string().nullable() }).nullable(),
});

export class IntegrationError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

export class T3CodeRunner implements Runner {
  constructor(private readonly url: string, private readonly token: string) { registerSecrets(token); }

  private async request(endpoint: string, command?: RunnerCommand, post = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(endpoint, this.url), {
        method: command || post ? "POST" : "GET", redirect: "error",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: command ? JSON.stringify(command) : undefined,
        // Only bounds one network request, never coding execution or human waits.
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new IntegrationError("T3Code connection failed. Check T3CODE_URL and private-network connectivity; persisted work will be reconciled."); }
    if (response.status === 404 && !command) return null;
    if (!response.ok) throw new IntegrationError(`T3Code HTTP ${response.status}. Check orchestration scopes, credentials and the current T3Code contract.`, response.status >= 500 || response.status === 429);
    try { return await response.json(); }
    catch { throw new IntegrationError("T3Code returned invalid JSON. Check the current orchestration contract.", false); }
  }

  async projects() {
    const parsed = z.object({ projects: z.array(z.object({ id: z.string(), workspaceRoot: z.string() })) }).safeParse(await this.request("/api/orchestration/snapshot"));
    if (!parsed.success) throw new IntegrationError("T3Code snapshot contract changed; expected projects with workspaceRoot.", false);
    return parsed.data.projects;
  }

  async snapshot(threadId: string): Promise<{ sequence: number; thread: RunnerThread } | null> {
    const data = await this.request(`/api/orchestration/threads/${encodeURIComponent(threadId)}`);
    if (data === null) return null;
    const parsed = z.object({ snapshotSequence: z.number().int().nonnegative(), thread: ThreadSchema }).safeParse(data);
    if (!parsed.success) throw new IntegrationError("T3Code thread snapshot contract changed; update the bridge adapter.", false);
    if (parsed.data.thread.id !== threadId) throw new IntegrationError("T3Code returned a different thread identity.", false);
    return { sequence: parsed.data.snapshotSequence, thread: parsed.data.thread };
  }

  async replay(threadId: string, afterSequence: number): Promise<ReplayResult> {
    const ticket = z.object({ ticket: z.string() }).safeParse(await this.request("/api/auth/websocket-ticket", undefined, true));
    if (!ticket.success) throw new IntegrationError("T3Code WebSocket ticket contract changed.", false);
    const url = new URL("/ws", this.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.data.ticket);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const events: Array<{ sequence: number; activity: RunnerActivity }> = [];
      let snapshot: ReplayResult["snapshot"];
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error); else resolve({ events, snapshot });
      };
      const timer = setTimeout(() => finish(new IntegrationError("T3Code event catch-up timed out; will reconnect from the durable cursor.")), 30_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        _tag: "Request", id: "replay", tag: "orchestration.subscribeThread", headers: [],
        payload: { threadId, afterSequence, requestCompletionMarker: true },
      })));
      socket.addEventListener("error", () => finish(new IntegrationError("T3Code event connection failed; check orchestration read scope and private-network connectivity.")));
      socket.addEventListener("close", () => finish(new IntegrationError("T3Code event connection closed before synchronization.")));
      socket.addEventListener("message", event => {
        try {
          const decoded: unknown = JSON.parse(String(event.data));
          const frames = z.array(z.object({ _tag: z.string(), requestId: z.union([z.string(), z.number()]).optional(), values: z.array(z.unknown()).optional() })).parse(Array.isArray(decoded) ? decoded : [decoded]);
          for (const frame of frames) {
            if (frame._tag === "Pong") continue;
            if (frame._tag !== "Chunk" || frame.requestId !== "replay" || !frame.values) throw new Error("Unexpected event transport frame");
            for (const value of frame.values) {
              const item = z.object({ kind: z.string(), event: z.unknown().optional(), snapshot: z.unknown().optional() }).parse(value);
              if (item.kind === "synchronized") { finish(); return; }
              if (item.kind === "snapshot") {
                const fallback = z.object({ snapshotSequence: z.number().int().nonnegative(), thread: ThreadSchema }).parse(item.snapshot);
                if (fallback.thread.id !== threadId) throw new Error("Fallback thread mismatch");
                snapshot = { sequence: fallback.snapshotSequence, thread: fallback.thread };
                continue;
              }
              if (item.kind !== "event") throw new Error("Unknown event stream item");
              const remote = z.object({ type: z.string(), sequence: z.number(), payload: z.object({ threadId: z.string().optional(), activity: z.unknown().optional() }) }).parse(item.event);
              if (remote.type === "thread.activity-appended" && remote.payload.threadId === threadId) {
                events.push({ sequence: remote.sequence, activity: ThreadSchema.shape.activities.element.parse(remote.payload.activity) });
              }
            }
            socket.send(JSON.stringify({ _tag: "Ack", requestId: "replay" }));
          }
        } catch { finish(new IntegrationError("T3Code event replay could not be verified. The stream contract changed; update the adapter before resuming.", false)); }
      });
    });
  }

  async dispatch(command: RunnerCommand) {
    const result = z.object({ sequence: z.number().int().nonnegative() }).safeParse(await this.request("/api/orchestration/dispatch", command));
    if (!result.success) throw new IntegrationError("T3Code command acknowledgement is uncertain; reconciling its persisted command ID.");
  }
}
