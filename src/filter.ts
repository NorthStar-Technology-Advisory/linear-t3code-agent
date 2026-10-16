import { z } from "zod";
import type { Policy } from "./config.js";

const envelope = z.object({
  type: z.string(), action: z.enum(["create", "update", "remove"]),
  organizationId: z.string(), webhookTimestamp: z.number().finite(),
  data: z.record(z.unknown()), updatedFrom: z.record(z.unknown()).optional(),
});
const issue = z.object({ id: z.string().min(1), projectId: z.string().nullable().optional(), stateId: z.string().nullable().optional() });
export type Decision = { forward: boolean; reason: string };

// Classification only: T3 remains responsible for authoritative ownership, holds and capacity.
export const classify = (input: unknown, policy: Policy): Decision => {
  const event = envelope.parse(input);
  if (event.organizationId !== policy.organizationId) return { forward: false, reason: "other_organization" };
  if (event.type !== "Issue") return { forward: false, reason: "other_resource" };
  const data = issue.parse(event.data);
  const previous = event.updatedFrom ?? {};
  const inScope = [data.projectId, previous.projectId].some(id => typeof id === "string" && policy.projectIds.includes(id));
  if (!inScope) return { forward: false, reason: "other_project" };
  if (event.action !== "remove" && !data.stateId) throw new Error("Issue stateId is required");
  const tracked = [data.stateId, previous.stateId].some(id => typeof id === "string" && policy.trackedStateIds.includes(id));
  if (event.action === "create") {
    return { forward: !!data.stateId && policy.actionableStateIds.includes(data.stateId), reason: "issue_created" };
  }
  // A removal may contain only partial issue data. Preserve a reconciliation hint when state is unknown.
  if (event.action === "remove") return { forward: !data.stateId || tracked, reason: "issue_removed" };
  if (!tracked) return { forward: false, reason: "inactive_state" };
  if (Object.hasOwn(previous, "stateId") && previous.stateId !== data.stateId) return { forward: true, reason: "state_changed" };
  if (Object.hasOwn(previous, "projectId") && previous.projectId !== data.projectId) return { forward: true, reason: "project_changed" };
  const relevantFields = ["parentId", "labelIds", "priority", "assigneeId", "delegateId", "archivedAt", "canceledAt"];
  if (relevantFields.some(field => Object.hasOwn(previous, field))) return { forward: true, reason: "routing_changed" };
  return { forward: false, reason: "routine_edit" };
};
