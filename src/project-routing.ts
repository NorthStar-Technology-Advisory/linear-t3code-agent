import { realpath } from "node:fs/promises";
import { git } from "./repository.js";
import type { RunnerProject } from "./runner.js";
import { readProjectConfig } from "./project-config.js";
export type ProjectQuery = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
export async function projectTitle(query: ProjectQuery, projectId: string | undefined): Promise<string> {
  return (await readProjectConfig(query, projectId)).project;
}

export async function matchProject(projects: RunnerProject[], title: string): Promise<RunnerProject> {
  const matches = projects.filter(p => p.deletedAt === null && p.title === title);
  if (matches.length === 0) throw new Error(`No active T3Code project has the exact title "${title}". Correct the YAML project title, then send resume.`);
  if (matches.length > 1) {
    const ambiguous = () => new Error(`Multiple T3Code projects have title "${title}": ${matches.map(p => p.workspaceRoot).join(", ")}. Cannot verify a shared repository; give unrelated projects unique titles or repair their Git metadata, then send resume.`);
    try {
      const commonDirs = await Promise.all(matches.map(async p => realpath(await git(p.workspaceRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"))));
      if (new Set(commonDirs).size > 1) {
        const origins = await Promise.all(matches.map(async p => repositoryIdentity(await git(p.workspaceRoot, "remote", "get-url", "origin"))));
        if (origins.some(origin => !origin) || new Set(origins).size !== 1) throw ambiguous();
      }
    } catch { throw ambiguous(); }
  }
  // T3Code can group separate clones under one display title. Pin a deterministic
  // source checkout when the ticket first starts; future delegations reuse it.
  return matches.sort((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot) || a.id.localeCompare(b.id))[0]!;
}

function repositoryIdentity(remote: string): string | undefined {
  const scp = /^([^/@:]+@)?([^/:]+):(.+)$/.exec(remote);
  try {
    const url = new URL(scp && !remote.includes("://") ? `ssh://${scp[2]}/${scp[3]}` : remote);
    if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol)) return undefined;
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
  } catch { return undefined; }
}
