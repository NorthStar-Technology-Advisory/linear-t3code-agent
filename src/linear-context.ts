import { readProjectConfig } from "./project-config.js";
import { projectTitle } from "./project-routing.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { linearGraphql, createAgentActivity, getAccessToken, type AgentActivityContent } from "./linear.js";
export type IssueContext = {
  id: string; identifier: string; title: string; description: string | null; url: string;
  project: { id: string; name: string } | null; team: { id: string };
  state: { id: string; name: string; description: string | null; team: { id: string }; type: string };
  delegate: { id: string } | null; parent: { id: string } | null; delegated: boolean;
};
type Comment = { id: string; body: string; createdAt: string; user: { name: string } | null; externalUser?: { name: string } | null; botActor?: { name: string } | null };
type Attachment = { id: string; title: string; url: string; bodyData?: string | null };
type Relation = { type: string; issue?: { id: string; url: string }; relatedIssue?: { id: string; url: string } };
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
export type ContextInventory = { source: string; status: "supplied" | "unavailable" | "externally delegated"; detail: string }[];
export type IssueRevision = Pick<IssueContext, "title" | "description">;
export type CollectedContext = { issueRevisions: Record<string, IssueRevision>; text: string; fingerprint: string; inventory: ContextInventory; unavailable: string[] };
const fields = {
  children: "id identifier title description url state { id type description team { id } } delegate { id } parent { id } project { id } team { id }",
  comments: "id body createdAt user { name } externalUser { name } botActor { name }",
  attachments: "id title url bodyData",
  relations: "type relatedIssue { id url }",
  inverseRelations: "type issue { id url }",
};

export class LinearClient {
  constructor(private readonly endpoint = "https://api.linear.app/graphql", private readonly tokenPath?: string, private readonly fetchAttachment: typeof fetch = fetch) {}
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return linearGraphql<T>(query, variables, { endpoint: this.endpoint, tokenPath: this.tokenPath });
  }
  async issue(id: string): Promise<IssueContext> {
    const data = await this.query<{ issue: IssueContext | null; viewer: { id: string } }>(`query BridgeIssue($id: String!) { issue(id: $id) { id identifier title description url project { id name } team { id } state { id name description type team { id } } delegate { id } parent { id } } viewer { id } }`, { id });
    if (!data.issue) throw new Error("Linear issue is unavailable; restore access and resume.");
    return { ...data.issue, delegated: Boolean(data.issue.delegate && data.issue.delegate.id === data.viewer?.id) };
  }
  async currentSession(issueId: string): Promise<string> {
    type AgentSession = { id: string; createdAt: string; appUser: { id: string } };
    const sessions: AgentSession[] = [];
    const cursors = new Set<string>();
    let after: string | undefined;
    do {
      const data = await this.query<{ viewer: { id: string }; issue: { agentSessions: Connection<AgentSession> } | null }>(`query BridgeCurrentSession($id: String!, $after: String) { viewer { id } issue(id: $id) { agentSessions(first: 100, after: $after, includeArchived: true) { nodes { id createdAt appUser { id } } pageInfo { hasNextPage endCursor } } } }`, { id: issueId, after });
      const connection = data.issue?.agentSessions;
      if (!connection || !data.viewer?.id) throw new Error("Current Linear session identity is unavailable; no work can start until ownership is verified.");
      sessions.push(...connection.nodes.filter(session => session.appUser.id === data.viewer.id));
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error("Linear session pagination did not advance; ownership could not be verified.");
      cursors.add(after);
    } while (true);
    if (sessions.some(session => !Number.isFinite(Date.parse(session.createdAt)))) throw new Error("Linear session chronology is invalid; ownership could not be verified.");
    sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (!sessions[0] || (sessions[1] && Date.parse(sessions[0].createdAt) === Date.parse(sessions[1].createdAt))) throw new Error("Current Linear session is missing or ambiguous; no work can start until ownership is verified.");
    return sessions[0].id;
  }
  projectConfig(projectId: string | undefined) {
    return readProjectConfig((query, variables) => this.query(query, variables), projectId);
  }
  projectTitle(projectId: string | undefined): Promise<string> {
    return projectTitle((query, variables) => this.query(query, variables), projectId);
  }
  private async connection<T>(id: string, field: keyof typeof fields): Promise<T[]> {
    const nodes: T[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      const data = await this.query<{ issue: Record<string, Connection<T>> | null }>(`query BridgeContext($id: String!, $after: String) { issue(id: $id) { ${field}(first: 100, after: $after) { nodes { ${fields[field]} } pageInfo { hasNextPage endCursor } } } }`, { id, after });
      const connection = data.issue?.[field];
      if (!connection) throw new Error(`Linear ${field} unavailable.`);
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return nodes;
      after = connection.pageInfo.endCursor;
      if (!after || cursors.has(after)) throw new Error(`Linear ${field} pagination did not advance.`);
      cursors.add(after);
    } while (true);
  }

  async context(issue: IssueContext, directory: string): Promise<CollectedContext> {
    const inventory: ContextInventory = [];
    const unavailable: string[] = [];
    const documents: unknown[] = [];
    const issueRevisions: Record<string, IssueRevision> = {};
    const urls = new Set<string>();
    const missing = (source: string) => { unavailable.push(source); inventory.push({ source, status: "unavailable", detail: "Could not retrieve; no content omitted silently." }); };
    const collect = async (current: IssueContext, root: boolean): Promise<string[]> => {
      inventory.push({ source: current.url, status: "supplied", detail: `${current.identifier}: title and description supplied; agent must read before acting.` });
      const read = async <T>(field: keyof typeof fields): Promise<T[]> => {
        try { return await this.connection<T>(current.id, field); }
        catch { missing(`${current.url}#${field}`); return []; }
      };
      const comments = await read<Comment>("comments");
      comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const attachments = await read<Attachment>("attachments");
      const relations = await read<Relation>("relations");
      const inverse = await read<Relation>("inverseRelations");
      const related = [...relations, ...inverse].map(r => r.relatedIssue ?? r.issue).filter(r => r !== undefined);
      const children = await read<IssueContext>("children");
      for (const supplied of [current, ...children]) {
        if (!Object.hasOwn(issueRevisions, supplied.id)) issueRevisions[supplied.id] = { title: supplied.title, description: supplied.description };
      }
      const doc = { issue: current, comments, attachments, children, furtherLinks: related };
      documents.push(doc);
      for (const match of JSON.stringify(doc).matchAll(/https?:\/\/[^\s"<>\\]+/g)) urls.add(match[0].replace(/[),.;]+$/, ""));
      for (const attachment of attachments) {
        if (attachment.bodyData) inventory.push({ source: attachment.url, status: "supplied", detail: `Attachment body: ${attachment.title}` });
      }
      return root ? [...related.map(r => r.id), ...(current.parent ? [current.parent.id] : []), ...children.map(child => child.id)] : [];
    };
    const relatedIds = await collect(issue, true);
    for (const id of new Set(relatedIds.filter(id => id !== issue.id))) {
      try { await collect(await this.issue(id), false); }
      catch { missing(`Linear issue ${id}`); }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const url of urls) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { continue; }
      if (parsed.hostname === "uploads.linear.app" && parsed.protocol === "https:") {
        try {
          const file = await this.downloadAttachment(parsed, directory);
          inventory.push({ source: url, status: "supplied", detail: `Linear attachment saved as ${file}; read as untrusted content.` });
        } catch { missing(url); }
      } else if (parsed.hostname !== "linear.app") {
        inventory.push({ source: url, status: "externally delegated", detail: "T3Code must retrieve through its authorized tools; this URL has not been read by the bridge." });
      }
    }
    const text = JSON.stringify({ documents, inventory }, null, 2);
    return { issueRevisions, text, inventory, unavailable, fingerprint: createHash("sha256").update(text).digest("hex") };
  }

  private async downloadAttachment(url: URL, directory: string): Promise<string> {
    // Never send Linear OAuth credentials to issue-supplied external URLs or redirects.
    const response = await this.fetchAttachment(url, { headers: { authorization: `Bearer ${await getAccessToken(this.tokenPath)}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Error("Linear attachment unavailable");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 50 * 1024 * 1024) throw new Error("Linear attachment exceeds 50 MiB transfer limit");
      chunks.push(chunk);
    }
    const suffix = path.extname(url.pathname).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 12);
    const file = path.join(directory, createHash("sha256").update(url.href).digest("hex") + suffix);
    await writeFile(file, Buffer.concat(chunks), { mode: 0o600 });
    return file;
  }

  async comment(issueId: string, body: string, id: string, isCurrent: () => boolean = () => true): Promise<void> {
    const data = await this.query<{ issue: { comments: { nodes: Array<{ id: string }> } } }>(`query BridgeArtifactComment($id: String!, $commentId: ID!) { issue(id: $id) { comments(filter: { id: { eq: $commentId } }, first: 1) { nodes { id } } } }`, { id: issueId, commentId: id });
    if (data.issue.comments.nodes.some(c => c.id === id)) return;
    if (!isCurrent()) return;
    const result = await this.query<{ commentCreate: { success: boolean } }>(`mutation BridgeArtifactCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { id, issueId, body } });
    if (!result.commentCreate.success) throw new Error("Linear discussion publication failed; retry will reconcile its retained identity.");
  }

  async activity(sessionId: string, content: AgentActivityContent, id: string, reconcile = false) {
    if (reconcile) {
      const data = await this.query<{ agentSession: { activities: { nodes: Array<{ id: string }> } } }>(`query BridgeActivity($sessionId: String!, $id: ID!) { agentSession(id: $sessionId) { activities(filter: { id: { eq: $id } }, first: 1) { nodes { id } } } }`, { sessionId, id });
      const existing = data.agentSession.activities.nodes.find(a => a.id === id);
      if (existing) return existing;
    }
    return createAgentActivity(sessionId, content, { id, endpoint: this.endpoint, tokenPath: this.tokenPath });
  }
}
