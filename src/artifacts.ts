import { randomUUID } from "node:crypto";
import type { ArtifactOutput } from "./delivery.js";
import type { IssueContext, IssueRevision, LinearClient } from "./linear-context.js";
import { IntegrationError } from "./t3code-runner.js";

type Child = { id: string; title: string; description: string | null; parent: { id: string } | null; state: { type: string }; delegate: { id: string } | null };
type Mutation =
  | { kind: "spec"; id: string; before: string | null; description: string }
  | { kind: "child"; id: string; parentId: string; teamId: string; projectId?: string; title: string; description: string; before?: { title: string; description: string | null } }
  | { kind: "removeRelation"; id: string; relatedIssueId: string }
  | { kind: "relation"; id: string; issueId: string; relatedIssueId: string }
  | { kind: "comment"; id: string; issueId: string; body: string };
export type Publication = { blocked?: boolean; stageId: string; operations: Mutation[]; cursor: number; report: string; review: string[] };
export type ArtifactIdentities = { children: Record<string, string>; relations: Record<string, string> };

async function existingChild(linear: LinearClient, id: string): Promise<Child | undefined> {
  const result = await linear.query<{ issues: { nodes: Child[] } }>(`query BridgeArtifactIssue($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1) { nodes { id title description parent { id } state { type } delegate { id } } } }`, { id });
  return result.issues.nodes[0];
}
type BlockingRelation = { id: string; type: string; issue: { id: string } };
async function blockingRelations(linear: LinearClient, id: string): Promise<BlockingRelation[]> {
  const nodes: BlockingRelation[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const data = await linear.query<{ issue: { inverseRelations: { nodes: BlockingRelation[]; pageInfo: { hasNextPage: boolean; endCursor?: string } } } }>(`query BridgeArtifactRelations($id: String!, $after: String) { issue(id: $id) { inverseRelations(first: 100, after: $after) { nodes { id type issue { id } } pageInfo { hasNextPage endCursor } } } }`, { id, after });
    const connection = data.issue.inverseRelations;
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return nodes;
    after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new IntegrationError("Linear dependency pagination did not advance; restore access and resume.", false);
    cursors.add(after);
  } while (true);
}
const unstarted = (child: Child) => ["backlog", "unstarted", "triage"].includes(child.state.type) && !child.delegate;

/** Prepare identities before any remote write. The coordinator durably stores this plan. */
export async function preparePublication(linear: LinearClient, issue: IssueContext, stageId: string, artifacts: ArtifactOutput | undefined, summary: string, report: string, previous: ArtifactIdentities, issueRevisions: Record<string, IssueRevision> | undefined): Promise<{ publication: Publication; identities: ArtifactIdentities }> {
  const parent = issue.parent ? await linear.issue(issue.parent.id) : issue;
  const identities: ArtifactIdentities = structuredClone(previous);
  const operations: Mutation[] = [];
  const review: string[] = [];
  if (artifacts?.specification) operations.push({ kind: "spec", id: parent.id, before: artifacts.specification.previousDescription, description: artifacts.specification.description });
  const children = artifacts?.children ?? [];
  if (new Set(children.map(child => child.key)).size !== children.length) throw new IntegrationError("Ticket keys must be unique; revise the breakdown and resume.", false);
  const visit = (key: string, ancestors: Set<string>) => {
    if (ancestors.has(key)) throw new IntegrationError("Ticket dependencies contain a cycle; revise the approved breakdown.", false);
    const next = new Set(ancestors).add(key);
    for (const blocker of children.find(child => child.key === key)?.blockedBy ?? []) visit(blocker, next);
  };
  for (const child of children) visit(child.key, new Set());
  for (const child of children) {
    if (!Object.hasOwn(identities.children, child.key)) Object.defineProperty(identities.children, child.key, { value: randomUUID(), enumerable: true, writable: true, configurable: true });
  }
  for (const child of children) {
    if (child.blockedBy.some(key => key === child.key || !Object.hasOwn(identities.children, key))) throw new IntegrationError(`Invalid dependency for ticket ${child.key}; use another retained ticket key.`, false);
    const id = identities.children[child.key]!;
    const existing = await existingChild(linear, id);
    const description = `${child.description}\n\n## Acceptance criteria\n${child.acceptanceCriteria.map(c => `- ${c}`).join("\n")}\n\nSource specification: ${parent.url}\nBridge ticket key: ${child.key}`;
    if (existing && (!unstarted(existing) || existing.parent?.id !== parent.id)) {
      review.push(`${id} (${child.key}) is active, completed, delegated or no longer linked to this parent. Proposed scope: ${child.title}\n${description}\nProposed dependencies: ${child.blockedBy.join(", ") || "none"}. Human review required; commitments preserved.`);
      continue;
    }
    const before = issueRevisions && Object.hasOwn(issueRevisions, id) ? issueRevisions[id] : undefined;
    if (existing && (!before || existing.title !== before.title || existing.description !== before.description)) throw new IntegrationError(`Child ${id} changed since the context supplied to this turn, or its original context is unavailable. Preserve the human edits and send revision feedback to refresh context.`, false);
    operations.push({ kind: "child", id, parentId: parent.id, teamId: parent.team.id, projectId: parent.project?.id, title: child.title, description, ...(before ? { before } : {}) });
    for (const [key, relationId] of Object.entries(previous.relations)) {
      const separator = key.indexOf(":");
      if (key.slice(separator + 1) === child.key && !child.blockedBy.includes(key.slice(0, separator))) {
        operations.push({ kind: "removeRelation", id: relationId, relatedIssueId: id });
      }
    }
    const currentRelations = existing ? await blockingRelations(linear, id) : [];
    for (const blocker of child.blockedBy) {
      const key = `${blocker}:${child.key}`;
      const matches = currentRelations.filter(r => r.type === "blocks" && r.issue.id === identities.children[blocker]);
      if (matches.length > 1) throw new IntegrationError(`Ambiguous duplicate dependencies for ${child.key}; reconcile them in Linear before resuming.`, false);
      const relationId = identities.relations[key] = matches[0]?.id ?? (Object.hasOwn(identities.relations, key) ? identities.relations[key] : randomUUID());
      operations.push({ kind: "relation", id: relationId, issueId: identities.children[blocker]!, relatedIssueId: id });
    }
  }
  if (artifacts?.specification) review.push("Specification revised. Review downstream children against the current parent description before continuing implementation.");
  if (artifacts?.children) {
    for (const [key, id] of Object.entries(previous.children)) if (!children.some(c => c.key === key)) review.push(`Previously generated child ${id} (${key}) is omitted from this revision. Review its scope/dependencies; it was preserved.`);
  }
  // All child endpoints must exist before creating their dependency edges.
  operations.sort((a, b) => Number(a.kind === "relation" || a.kind === "removeRelation") - Number(b.kind === "relation" || b.kind === "removeRelation"));
  operations.push({ kind: "comment", id: randomUUID(), issueId: parent.id, body: `${summary}\n\n${review.join("\n\n")}\n\nStage invocation: ${stageId}. Awaiting human direction; no status or delegation changed.` });
  return { publication: { stageId, operations, cursor: 0, report, review }, identities };
}

/** A lost acknowledgement is reconciled by identity/content before retrying one write. */
export async function publishNext(linear: LinearClient, publication: Publication, isCurrent: () => boolean): Promise<string | void> {
  const operation = publication.operations[publication.cursor];
  if (!operation) return;
  const mutate = async (query: string, variables: Record<string, unknown>) => {
    if (!isCurrent()) return;
    const data = await linear.query<Record<string, { success: boolean }>>(query, variables);
    if (Object.values(data).length !== 1 || !Object.values(data).every(value => value.success === true)) throw new IntegrationError("Linear artifact publication failed; preserved publication will be reconciled.");
  };
  if (operation.kind === "spec") {
    const current = await linear.issue(operation.id);
    if (current.description === operation.description) return;
    if (current.description !== operation.before) throw new IntegrationError("The parent specification changed during publication. Work is preserved; review the current description before retrying this revision.", false);
    await mutate(`mutation BridgeArtifactUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id: operation.id, input: { description: operation.description } });
  } else if (operation.kind === "child") {
    const current = await existingChild(linear, operation.id);
    if (current?.parent?.id === operation.parentId && current.title === operation.title && current.description === operation.description) return;
    if (current && (!unstarted(current) || current.parent?.id !== operation.parentId)) throw new IntegrationError(`Child ${operation.id} started or changed parent during publication. Human review is required; its commitments were preserved.`, false);
    if (current && (!operation.before || current.title !== operation.before.title || current.description !== operation.before.description)) throw new IntegrationError(`Child ${operation.id} changed during publication. Review the existing artifact before retrying.`, false);
    if (current) await mutate(`mutation BridgeArtifactUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id: operation.id, input: { title: operation.title, description: operation.description } });
    else if (operation.before) throw new IntegrationError(`Previously published child ${operation.id} is unavailable; restore access before retrying.`, false);
    else await mutate(`mutation BridgeArtifactCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success } }`, { input: { id: operation.id, teamId: operation.teamId, projectId: operation.projectId, parentId: operation.parentId, title: operation.title, description: operation.description } });
  } else if (operation.kind === "relation" || operation.kind === "removeRelation") {
    const child = await existingChild(linear, operation.relatedIssueId);
    const relations = await blockingRelations(linear, operation.relatedIssueId);
    if (operation.kind === "removeRelation") {
      if (!relations.some(r => r.id === operation.id)) return;
      if (!child || !unstarted(child)) throw new IntegrationError(`Child ${operation.relatedIssueId} started during publication; review its dependencies manually.`, false);
      await mutate(`mutation BridgeArtifactRelationDelete($id: String!) { issueRelationDelete(id: $id) { success } }`, { id: operation.id });
      return;
    }
    const existing = relations.filter(r => r.type === "blocks" && r.issue.id === operation.issueId);
    if (existing.length > 1) throw new IntegrationError("Dependency publication found duplicate edges; reconcile them in Linear before retrying.", false);
    if (existing[0]) return existing[0].id;
    if (!child || !unstarted(child)) throw new IntegrationError(`Child ${operation.relatedIssueId} is no longer unstarted; review its dependencies manually.`, false);
    await mutate(`mutation BridgeArtifactRelation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`, { input: { id: operation.id, type: "blocks", issueId: operation.issueId, relatedIssueId: operation.relatedIssueId } });
  } else {
    await linear.comment(operation.issueId, operation.body, operation.id, isCurrent);
  }
}
