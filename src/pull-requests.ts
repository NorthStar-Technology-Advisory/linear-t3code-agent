import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { git, type Route } from "./repository.js";
const exec = promisify(execFile);
const PullRequestSchema = z.object({ number: z.number().int().positive(), url: z.string().url(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(), headRefName: z.string() });
export type PullRequest = z.infer<typeof PullRequestSchema>;
/** External PR host operations. The coding runner creates/updates draft PRs; the bridge verifies their lifecycle. */
export interface PullRequests {
  find(route: Route, branch: string): Promise<PullRequest | null>;
}
export class GitHubPullRequests implements PullRequests {
  async find(route: Route, branch: string): Promise<PullRequest | null> {
    let stdout: string;
    try {
      ({ stdout } = await exec("gh", ["pr", "list", "--state", "all", "--head", branch, "--json", "number,url,state,isDraft,headRefName", "--limit", "100"], { cwd: route.repository, timeout: 30_000 }));
    } catch { throw new Error("GitHub PR lookup failed. Check gh authentication and repository access; PR validation remains unavailable."); }
    const prs = z.array(PullRequestSchema).safeParse(JSON.parse(stdout));
    if (!prs.success) throw new Error("GitHub PR response could not be validated.");
    const matches = prs.data.filter(pr => pr.headRefName === branch);
    if (matches.length > 1) throw new Error("Multiple PRs match the session branch; operator reconciliation is required.");
    return matches[0] ?? null;
  }
}

export async function cleanupWorktree(route: Route, worktree: string): Promise<string> {
  const canonicalWorktree = await realpath(worktree).catch(() => worktree);
  const list = await git(route.repository, "worktree", "list", "--porcelain");
  if (!list.split("\n").includes(`worktree ${canonicalWorktree}`)) return "Worktree already removed; session mapping retained.";
  if (await git(worktree, "status", "--porcelain", "--untracked-files=all")) return "Worktree preserved: uncommitted or untracked changes remain.";
  await git(route.repository, "fetch", "--prune", "origin");
  if (await git(worktree, "rev-list", "HEAD", "--not", "--remotes=origin")) return "Worktree preserved: commits are not reachable from the current origin refs.";
  await git(route.repository, "worktree", "remove", worktree);
  return "Clean, fully pushed worktree removed; branch and session-to-thread mapping retained.";
}
