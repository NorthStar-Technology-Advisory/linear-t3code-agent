import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";

const ids = z.array(z.string().uuid()).min(1);
export const PolicySchema = z.object({
  organizationId: z.string().uuid(),
  projectIds: ids,
  actionableStateIds: ids,
  trackedStateIds: ids,
}).strict().superRefine((policy, context) => {
  if (policy.actionableStateIds.some(id => !policy.trackedStateIds.includes(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Actionable states must also be tracked" });
  }
});
export type Policy = z.infer<typeof PolicySchema>;

const webhookUrl = z.string().url().refine(value => {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return (url.protocol === "https:" || (local && url.protocol === "http:")) &&
    !url.username && !url.password && !url.hash;
}, "Use HTTPS (HTTP is allowed only for loopback tests)");
export const ConfigSchema = z.object({
  LINEAR_WEBHOOK_SECRET: z.string().min(16),
  T3_WEBHOOK_URL: webhookUrl,
  T3_WEBHOOK_SECRET: z.string().min(16).optional(),
  FORWARDER_POLICY_PATH: z.string().default("./data/forwarder-policy.json"),
  FORWARDER_DB_PATH: z.string().refine(value => basename(value) !== "bridge.sqlite", "Use a separate forwarder receipt database").default("./data/forwarder.sqlite"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  FORWARD_TIMEOUT_MS: z.coerce.number().int().min(50).max(4000).default(3000),
  MAX_DELIVERY_AGE_MS: z.coerce.number().int().min(1000).max(300000).default(300000),
});
export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): { config: Config; policy: Policy } => {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid forwarder configuration: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  }
  const policy = PolicySchema.safeParse(JSON.parse(readFileSync(parsed.data.FORWARDER_POLICY_PATH, "utf8")));
  if (!policy.success) throw new Error("Invalid forwarder policy; see policy.example.json");
  return { config: parsed.data, policy: policy.data };
};
