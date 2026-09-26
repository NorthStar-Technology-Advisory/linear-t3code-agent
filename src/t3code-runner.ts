import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { registerSecrets } from "./secrets.js";
import { z } from "zod";
import type { Runner, RunnerCommand, RunnerThread, RunnerActivity, ReplayResult, RunnerProject, ProjectExecution } from "./runner.js";

const ModelSchema = z.object({ instanceId: z.string().min(1), model: z.string().min(1) }).passthrough();
const WorkspaceMode = z.enum(["local", "worktree"]);
const OverridesSchema = z.object({ defaultModelSelection: ModelSchema.nullable().optional(), defaultThreadEnvMode: WorkspaceMode.optional(), newWorktreesStartFromOrigin: z.boolean().optional() });
const SettingsSchema = z.object({
  defaultModelSelection: ModelSchema.nullable(), defaultThreadEnvMode: WorkspaceMode, newWorktreesStartFromOrigin: z.boolean(),
  providerInstances: z.record(z.object({ enabled: z.boolean().optional(), config: z.object({ enabled: z.boolean().optional() }).passthrough().optional() })), providers: z.record(z.object({ enabled: z.boolean() })),
  projectSettingsFolded: z.boolean().optional(), projectSettingsOverrides: z.record(OverridesSchema).optional(),
});

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

  async skill(name: string, repository: string, instanceId: string): Promise<string> {
    const skillSchema = z.object({ name: z.string(), path: z.string(), enabled: z.boolean(), userInvocable: z.boolean().optional() });
    const responseSchema = z.object({ providers: z.array(z.object({ instanceId: z.string(), workspaceSnapshots: z.array(z.object({ cwd: z.string(), skills: z.array(skillSchema) })).optional() })) });
    // Provider refresh can briefly return an incomplete workspace inventory.
    // Confirm an apparent miss before treating a required skill as unavailable.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = responseSchema.safeParse(await this.rpc("server.refreshProviders", { instanceId, cwd: repository }));
      const skills = result.success ? result.data.providers.find(p => p.instanceId === instanceId)?.workspaceSnapshots?.find(w => w.cwd === repository)?.skills : undefined;
      const matches = skills?.filter(s => s.name === name && s.enabled && s.userInvocable !== false) ?? [];
      if (matches.length === 1) return matches[0]!.path;
      if (matches.length > 1) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new IntegrationError(`Workflow skill ${name} is unavailable or ambiguous for ${instanceId} in ${repository}. Install/enable it in the T3Code execution environment, verify workspace skill discovery, then send resume. The bridge does not install skills.`, false);
  }

  async projects() {
    const parsed = z.object({ projects: z.array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string(), deletedAt: z.string().nullable(), defaultModelSelection: ModelSchema.nullable(), defaultThreadEnvMode: WorkspaceMode.nullish() })) }).safeParse(await this.request("/api/orchestration/snapshot"));
    if (!parsed.success) throw new IntegrationError("T3Code snapshot contract changed; expected projects with workspaceRoot.", false);
    return parsed.data.projects;
  }

  private async authenticatedSocket(): Promise<WebSocket> {
    const ticket = z.object({ ticket: z.string() }).safeParse(await this.request("/api/auth/websocket-ticket", undefined, true));
    if (!ticket.success) throw new IntegrationError("T3Code WebSocket ticket contract changed.", false);
    const url = new URL("/ws", this.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.data.ticket);
    return new WebSocket(url);
  }

  /** Unary calls use the same authenticated Effect RPC transport as event replay. */
  private async rpc(tag: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const socket = await this.authenticatedSocket();
    const dispatching = tag === "orchestration.dispatchCommand";
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value?: unknown, error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.close();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(undefined, new IntegrationError(`T3Code ${tag} timed out; check connectivity and send resume.`, dispatching)), 30_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ _tag: "Request", id: "call", tag, headers: [], payload })));
      socket.addEventListener("error", () => finish(undefined, new IntegrationError(`T3Code ${tag} connection failed; check credentials and send resume.`, dispatching)));
      socket.addEventListener("close", () => finish(undefined, new IntegrationError(`T3Code ${tag} closed before completion.`, dispatching)));
      socket.addEventListener("message", event => {
        try {
          const data: unknown = JSON.parse(String(event.data));
          const frames = z.array(z.object({ _tag: z.string(), requestId: z.union([z.string(), z.number()]).optional(), exit: z.object({ _tag: z.string(), value: z.unknown().optional() }).optional() })).parse(Array.isArray(data) ? data : [data]);
          for (const frame of frames) {
            if (frame._tag === "Pong") continue;
            if (frame._tag !== "Exit" || frame.requestId !== "call" || frame.exit?._tag !== "Success") throw new Error("RPC failed");
            finish(frame.exit.value);
          }
        } catch { finish(undefined, new IntegrationError(`T3Code ${tag} failed or its contract changed. Check API scopes and the installed T3Code version, then send resume.`, false)); }
      });
    });
  }

  async baseBranch(repository: string): Promise<string> {
    let cursor: number | undefined;
    const cursors = new Set<number>();
    do {
      const result = z.object({ isRepo: z.boolean(), refs: z.array(z.object({ name: z.string(), isDefault: z.boolean() })), nextCursor: z.number().nullable() }).safeParse(await this.rpc("vcs.listRefs", { cwd: repository, limit: 200, ...(cursor !== undefined ? { cursor } : {}) }));
      if (!result.success || !result.data.isRepo) throw new IntegrationError("T3Code cannot list repository branches; check its VCS contract and send resume.", false);
      const branch = result.data.refs.find(ref => ref.isDefault);
      if (branch) return branch.name;
      if (result.data.nextCursor === null) break;
      cursor = result.data.nextCursor;
      if (cursors.has(cursor)) throw new IntegrationError("T3Code branch pagination did not advance.", false);
      cursors.add(cursor);
    } while (true);
    const status = z.object({ isRepo: z.boolean(), refName: z.string().nullable() }).safeParse(await this.rpc("vcs.refreshStatus", { cwd: repository }));
    if (!status.success || !status.data.isRepo || !status.data.refName) throw new IntegrationError("No repository default or checked-out branch is available. Select a branch in T3Code and send resume.", false);
    return status.data.refName;
  }

  async execution(project: RunnerProject): Promise<ProjectExecution> {
    const [rawSettings, rawConfig] = await Promise.all([this.rpc("server.getSettings"), this.rpc("server.getConfig")]);
    const parsed = SettingsSchema.safeParse(rawSettings);
    const config = z.object({ providers: z.array(z.object({ instanceId: z.string(), enabled: z.boolean(), installed: z.boolean(), availability: z.string().optional(), models: z.array(z.object({ slug: z.string(), aliases: z.array(z.string()).optional() })) })) }).safeParse(rawConfig);
    if (!parsed.success || !config.success) throw new IntegrationError("T3Code settings contract changed; update the adapter and send resume.", false);
    const settings = parsed.data;
    const enabled = (selection: z.infer<typeof ModelSchema>) => {
      const instance = settings.providerInstances[selection.instanceId];
      if (!instance) return settings.providers[selection.instanceId]?.enabled === true;
      if (instance.enabled === false || instance.config?.enabled === false) return false;
      return instance.enabled ?? instance.config?.enabled ?? config.data.providers.find(p => p.instanceId === selection.instanceId)?.enabled === true;
    };
    const overrides = {
      ...(!settings.projectSettingsFolded && project.defaultModelSelection ? { defaultModelSelection: project.defaultModelSelection } : {}),
      ...(!settings.projectSettingsFolded && project.defaultThreadEnvMode ? { defaultThreadEnvMode: project.defaultThreadEnvMode } : {}),
      ...settings.projectSettingsOverrides?.[project.id],
    };
    // A disabled project provider inherits the environment selection, as T3Code does.
    const override = overrides.defaultModelSelection;
    const selection = override === null ? null : override && enabled(override) ? override : settings.defaultModelSelection;
    const provider = config.data.providers.find(p => p.instanceId === selection?.instanceId);
    if (!selection || !enabled(selection) || !provider?.enabled || !provider.installed || provider.availability === "unavailable" || !provider.models.some(m => m.slug === selection.model || m.aliases?.includes(selection.model))) {
      throw new IntegrationError("No available effective T3Code provider/model. Configure the project's model or environment default and provider in T3Code, then send resume.", false);
    }
    let fileMode: "local" | "worktree" | undefined;
    if (!overrides.defaultThreadEnvMode) {
      let text: string | undefined;
      try { text = await readFile(path.join(project.workspaceRoot, "t3.json"), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new IntegrationError("Cannot read repository t3.json; restore access and send resume.", false); }
      if (text !== undefined) {
        const errors: ParseError[] = [];
        const file = z.object({ defaultThreadEnvMode: WorkspaceMode.optional() }).safeParse(parse(text, errors, { allowTrailingComma: true }));
        if (errors.length || !file.success) throw new IntegrationError("Invalid repository t3.json workspace settings; correct the file and send resume.", false);
        fileMode = file.data.defaultThreadEnvMode;
      }
    }
    return { modelSelection: selection, workspaceMode: overrides.defaultThreadEnvMode ?? fileMode ?? settings.defaultThreadEnvMode, startFromOrigin: overrides.newWorktreesStartFromOrigin ?? settings.newWorktreesStartFromOrigin };
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
    const socket = await this.authenticatedSocket();
    return new Promise((resolve, reject) => {
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
    const result = z.object({ sequence: z.number().int().nonnegative() }).safeParse(command.bootstrap ? await this.rpc("orchestration.dispatchCommand", command) : await this.request("/api/orchestration/dispatch", command));
    if (!result.success) throw new IntegrationError("T3Code command acknowledgement is uncertain; reconciling its persisted command ID.");
  }
}
