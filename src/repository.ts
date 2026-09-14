import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
export type Route = { repository: string; t3ProjectId: string; provider: string; model: string; baseBranch: string };
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try { return (await exec("git", ["-C", cwd, ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error(`Git ${args[0]} failed in the configured repository; check repository access and branch state.`); }
}
export async function prepareWorktree(route: Route, worktree: string, branch: string): Promise<void> {
  await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
  const canonicalWorktree = await realpath(worktree).catch(() => worktree);
  const listings = await git(route.repository, "worktree", "list", "--porcelain");
  const existing = listings.split("\n\n").find(entry => entry.split("\n")[0] === `worktree ${canonicalWorktree}`);
  if (existing) {
    if (!existing.split("\n").includes(`branch refs/heads/${branch}`)) throw new Error("Session worktree points at a different branch; preserved for operator inspection.");
    return;
  }
  await git(route.repository, "worktree", "add", "-b", branch, worktree, route.baseBranch);
}
export async function verifyProjectRepository(repository: string, workspaceRoot: string) {
  if (await realpath(repository) !== await realpath(workspaceRoot)) throw new Error("Configured repository differs from the T3Code project workspaceRoot. Fix PROJECT_ROUTES before resuming.");
}
