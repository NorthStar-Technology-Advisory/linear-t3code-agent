import type { IssueContext } from "./linear-context.js";
import type { ResolvedProjectConfig, StatusConfig } from "./project-config.js";
import { IntegrationError } from "./t3code-runner.js";

export type Stage = {
  id: string; output: StatusConfig["output"]; statusId: string; teamId: string;
  prompt: string; instructions?: string; skills: Array<{ name: string; path: string }>;
};
export function selectStatus(issue: IssueContext, config: ResolvedProjectConfig) {
  if (!issue.state || issue.state.team.id !== issue.team.id) throw new IntegrationError("Linear status identity is unavailable or belongs to another team; restore access and resume.", false);
  return config.statuses.find(status => status.teamId === issue.team.id && status.statusId === issue.state.id);
}

export function workflowGate(issue: IssueContext): string {
  return `${issue.team.id}:${issue.state?.id}:${issue.delegated}`;
}
