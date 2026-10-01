import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { git, type Route } from "./repository.js";
const exec = promisify(execFile);
const PullRequestSchema = z.object({ number: z.number().int().positive(), url: z.string().url(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(), headRefName: z.string(), headRefOid: z.string().regex(/^[a-f0-9]{40,64}$/).optional() });
export type PullRequest = z.infer<typeof PullRequestSchema>;
/** External PR host operations. The coding runner creates/updates draft PRs; the bridge verifies their lifecycle. */
export interface PullRequests {
  find(route: Route, branch: string): Promise<PullRequest | null>;
}
export class GitHubPullRequests implements PullRequests {
  async find(route: Route, branch: string): Promise<PullRequest | null> {
    let stdout: string;
    try {
      ({ stdout } = await exec("gh", ["pr", "list", "--state", "all", "--head", branch, "--json", "number,url,state,isDraft,headRefName,headRefOid", "--limit", "100"], { cwd: route.repository, timeout: 30_000 }));
    } catch { throw new Error("GitHub PR lookup failed. Check gh authentication and repository access; PR validation remains unavailable."); }
    const prs = z.array(PullRequestSchema).safeParse(JSON.parse(stdout));
    if (!prs.success) throw new Error("GitHub PR response could not be validated.");
    const matches = prs.data.filter(pr => pr.headRefName === branch);
    if (matches.length > 1) throw new Error("Multiple PRs match the session branch; operator reconciliation is required.");
    return matches[0] ?? null;
  }
}

export async function cleanupWorktree(route: Route, worktree: string, mergedPr?: PullRequest, expectedBranch?: string, canRemove: () => boolean = () => true): Promise<string> {
  const canonicalWorktree = await realpath(worktree).catch(() => worktree);
  if (canonicalWorktree === await realpath(route.repository)) return "Worktree preserved: this is the source checkout.";
  const list = await git(route.repository, "worktree", "list", "--porcelain");
  if (!list.split("\n").includes(`worktree ${canonicalWorktree}`)) return "Worktree already removed; session mapping retained.";
  if (expectedBranch && await git(worktree, "branch", "--show-current") !== expectedBranch) return "Worktree preserved: its branch no longer matches the saved workspace.";
  if (await git(worktree, "status", "--porcelain", "--untracked-files=all")) return "Worktree preserved: uncommitted or untracked changes remain.";
  const ignored = await git(worktree, "ls-files", "--others", "--ignored", "--exclude-standard");
  // Only explicitly disposable dependencies/caches may be removed after a verified merge.
  const disposable = (file: string) => file.split("/").slice(0, -1).some(part => ["node_modules", ".next", ".turbo", "coverage"].includes(part));
  if (ignored && (mergedPr?.state !== "MERGED" || ignored.split("\n").some(file => !disposable(file)))) return "Worktree preserved: ignored local files remain.";
  await git(route.repository, "fetch", "--prune", "origin");
  if (await git(worktree, "rev-list", "HEAD", "--not", "--remotes=origin")) {
    if (mergedPr?.state !== "MERGED" || !mergedPr.headRefOid || mergedPr.headRefName !== await git(worktree, "branch", "--show-current")) return "Worktree preserved: commits are not reachable from the current origin refs.";
    // Squash/rebase merges can remove the original commits from origin branches.
    // Verify the PR head independently against its remote pull ref before using it.
    await git(worktree, "fetch", "origin", `refs/pull/${mergedPr.number}/head`);
    if (await git(worktree, "rev-parse", "FETCH_HEAD") !== mergedPr.headRefOid || await git(worktree, "rev-list", "HEAD", "--not", mergedPr.headRefOid)) return "Worktree preserved: local commits are not contained in the verified merged PR head.";
  }
  if (!canRemove()) return "Worktree preserved: a new turn owns the workspace.";
  await git(route.repository, "worktree", "remove", worktree);
  return "Clean, fully pushed worktree removed; branch and session-to-thread mapping retained.";
}
