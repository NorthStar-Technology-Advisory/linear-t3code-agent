import type { IssueContext } from "./linear-context.js";
import { IntegrationError } from "./t3code-runner.js";

export type Workflow = "grill-me" | "to-spec" | "to-tickets" | "implement";
export type Stage = { id: string; workflow: Workflow; statusId: string; teamId: string; skillPath: string };
export function selectWorkflow(issue: IssueContext): Workflow | undefined {
  if (!issue.state || issue.state.team.id !== issue.team.id) throw new IntegrationError("Linear status identity is unavailable or belongs to another team; restore access and resume.", false);
  const description = issue.state.description ?? "";
  const markers = description.split(/\r?\n/).filter(line => /t3code\s*:/i.test(line));
  if (!markers.length) return;
  const match = markers.length === 1 ? /^\s*t3code: (grill-me|to-spec|to-tickets|implement)\s*$/.exec(markers[0]!) : null;
  if (!match) throw new IntegrationError("Invalid workflow marker. Use exactly one standalone line: t3code: grill-me, t3code: to-spec, t3code: to-tickets, or t3code: implement. Correct the status description and send resume.", false);
  return match[1] as Workflow;
}

export function workflowGate(issue: IssueContext): string {
  return `${issue.team.id}:${issue.state?.id}:${issue.delegated}`;
}
