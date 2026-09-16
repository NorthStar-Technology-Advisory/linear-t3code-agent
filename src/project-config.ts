import { parseDocument } from "yaml";
import { IntegrationError } from "./t3code-runner.js";
import { z } from "zod";
import type { ProjectQuery } from "./project-routing.js";

export const OutputSchema = z.enum(["comment", "specification", "tickets", "draft-pr"]);
const StatusSchema = z.object({
  prompt: z.string().refine(value => value.trim().length > 0, "Prompt must not be empty"),
  output: OutputSchema,
  "new-thread": z.boolean().default(false),
  "required-skills": z.array(z.string().trim().min(1)).default([]),
}).strict();
const ConfigSchema = z.object({
  t3code: z.object({
    version: z.literal(1),
    project: z.string().refine(value => value.trim().length > 0, "Project title must not be empty"),
    instructions: z.string().optional(),
    workflows: z.array(z.object({
      team: z.string().trim().min(1),
      statuses: z.record(z.string().min(1), StatusSchema).refine(value => Object.keys(value).length > 0, "At least one status is required"),
    }).strict()).min(1),
  }).strict(),
}).strict();
export type StatusConfig = z.infer<typeof StatusSchema>;
export type ProjectConfig = z.infer<typeof ConfigSchema>["t3code"];
export type ResolvedStatus = StatusConfig & { teamId: string; statusId: string };
export type ResolvedProjectConfig = { project: string; instructions?: string; statuses: ResolvedStatus[] };
const correction = "Correct the t3code YAML block in the Linear project's detailed description, then send resume.";
function invalid(message: string): never { throw new IntegrationError(`${message} ${correction}`, false); }

/** Accept labelled and unlabelled Markdown fences; prose and unrelated examples are ignored. */
export function parseProjectConfig(content: string | null): ProjectConfig {
  const candidates: string[] = [];
  const lines = (content ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(lines[i]!);
    if (!opening) continue;
    const fence = opening[1]!;
    const body: string[] = [];
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    while (++i < lines.length && !closing.test(lines[i]!)) body.push(lines[i]!);
    const text = body.join("\n");
    if (!/^\s*(?:t3code|"t3code"|'t3code')\s*:/m.test(text)) continue;
    if (i === lines.length) invalid("The t3code code fence is not closed.");
    if (!["", "yaml", "yml"].includes(opening[2]!.trim().toLowerCase())) invalid("Use a YAML or unlabelled code fence for t3code configuration.");
    candidates.push(text);
  }
  if (candidates.length !== 1) invalid(`Found ${candidates.length} t3code configuration blocks; exactly one is required.`);
  let value: unknown;
  try {
    const document = parseDocument(candidates[0]!, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) invalid("Invalid YAML syntax, duplicate key or unsupported tag.");
    value = document.toJS({ maxAliasCount: 0 });
  } catch { invalid("Invalid YAML syntax, duplicate key, tag or alias."); }
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) invalid(`Invalid configuration: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const config = parsed.data.t3code;
  if (new Set(config.workflows.map(w => w.team)).size !== config.workflows.length) invalid("Each team must appear only once.");
  return config;
}

type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
async function collect<T>(read: (after?: string) => Promise<Connection<T> | undefined>): Promise<T[]> {
  const nodes: T[] = [], cursors = new Set<string>();
  let after: string | undefined;
  do {
    const connection = await read(after);
    if (!connection) invalid("Project teams or issue statuses are unavailable.");
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return nodes;
    const next = connection.pageInfo.endCursor;
    if (!next || cursors.has(next)) invalid("Project configuration pagination did not advance.");
    cursors.add(next); after = next;
  } while (true);
}

export async function readProjectConfig(query: ProjectQuery, projectId: string | undefined): Promise<ResolvedProjectConfig> {
  if (!projectId) invalid("This issue has no Linear project.");
  const data = await query<{ project: { content: string | null } | null }>(
    "query BridgeProjectConfig($id: String!) { project(id: $id) { content } }", { id: projectId });
  if (!data.project) invalid("Linear project is unavailable.");
  const config = parseProjectConfig(data.project.content);
  const teams = await collect<{ id: string; key: string }>(async after => {
    const data = await query<{ project: { teams: Connection<{ id: string; key: string }> } | null }>(
      "query BridgeProjectTeams($id: String!, $after: String) { project(id: $id) { teams(first: 100, after: $after) { nodes { id key } pageInfo { hasNextPage endCursor } } } }", { id: projectId, after });
    return data.project?.teams;
  });
  const statuses: ResolvedStatus[] = [];
  for (const workflow of config.workflows) {
    const matches = teams.filter(team => team.key === workflow.team);
    if (matches.length !== 1) invalid(`Team ${workflow.team} must match exactly one team on this Linear project.`);
    const teamId = matches[0]!.id;
    const states = await collect<{ id: string; name: string }>(async after => {
      const data = await query<{ team: { states: Connection<{ id: string; name: string }> } | null }>(
        "query BridgeTeamStatuses($id: String!, $after: String) { team(id: $id) { states(first: 100, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } } }", { id: teamId, after });
      return data.team?.states;
    });
    for (const [name, settings] of Object.entries(workflow.statuses)) {
      const matches = states.filter(state => state.name === name);
      if (matches.length !== 1) invalid(`Status "${name}" must match exactly one status in team ${workflow.team}.`);
      statuses.push({ ...settings, teamId, statusId: matches[0]!.id });
    }
  }
  return { project: config.project, instructions: config.instructions, statuses };
}
