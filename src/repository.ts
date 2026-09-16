import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import type { ProjectExecution } from "./runner.js";
export type Route = ProjectExecution & { repository: string; t3ProjectId: string; baseBranch: string };
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try { return (await exec("git", ["-C", cwd, ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error(`Git ${args[0]} failed in the configured repository; check repository access and branch state.`); }
}
export async function prepareCheckout(route: Route, branch: string): Promise<void> {
  if (await git(route.repository, "branch", "--show-current") === branch) return;
  await git(route.repository, "switch", "-c", branch, "HEAD");
}

export function ticketBranch(identifier: string, title: string): string {
  const slug = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const key = slug(identifier);
  if (!key) throw new Error("Linear issue identifier is missing; cannot allocate a ticket branch.");
  const summary = slug(title).slice(0, 100).replace(/-+$/, "");
  return `t3code/${key}${summary ? `-${summary}` : ""}`;
}
