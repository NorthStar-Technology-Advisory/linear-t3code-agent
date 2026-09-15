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
