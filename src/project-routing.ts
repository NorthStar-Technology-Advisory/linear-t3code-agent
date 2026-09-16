import type { RunnerProject } from "./runner.js";
import { readProjectConfig } from "./project-config.js";
export type ProjectQuery = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
export async function projectTitle(query: ProjectQuery, projectId: string | undefined): Promise<string> {
  return (await readProjectConfig(query, projectId)).project;
}

export function matchProject(projects: RunnerProject[], title: string): RunnerProject {
  const matches = projects.filter(p => p.deletedAt === null && p.title === title);
  if (matches.length === 0) throw new Error(`No active T3Code project has the exact title "${title}". Correct the YAML project title, then send resume.`);
  if (matches.length > 1) throw new Error(`Multiple T3Code projects have title "${title}": ${matches.map(p => p.workspaceRoot).join(", ")}. Rename them to unique titles, correct the YAML project title, then send resume.`);
  return matches[0]!;
}
