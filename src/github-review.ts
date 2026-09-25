import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { config } from "./config.js";

const exec = promisify(execFile);
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
export const GitHubReviewSchema = z.object({
  action: z.literal("submitted"),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  pull_request: z.object({ number: z.number().int().positive(), html_url: z.string().url(), head: z.object({ ref: z.string().min(1) }) }),
  review: z.object({ id: z.number().int().positive(), state: z.enum(["approved", "changes_requested"]), commit_id: sha,
    html_url: z.string().url(), body: z.string().nullable().optional(), user: z.object({ login: z.string() }) }),
});
export type GitHubReview = z.infer<typeof GitHubReviewSchema>;
export type VerifiedPullRequest = { url: string; branch: string; head: string; open: boolean; checksPassing: boolean };
export interface GitHubReviews { verify(event: GitHubReview): Promise<VerifiedPullRequest>; }

export function verifyGitHubSignature(header: string | undefined, body: Buffer): boolean {
  if (!config.GITHUB_WEBHOOK_SECRET || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = crypto.createHmac("sha256", config.GITHUB_WEBHOOK_SECRET).update(body).digest();
  const actual = Buffer.from(header.slice(7), "hex");
  return crypto.timingSafeEqual(actual, expected);
}

async function gh<T>(...args: string[]): Promise<T> {
  const { stdout } = await exec("gh", args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

export class GitHubReviewClient implements GitHubReviews {
  async verify(event: GitHubReview): Promise<VerifiedPullRequest> {
    const repo = event.repository.full_name;
    const number = event.pull_request.number;
    const [review, pr] = await Promise.all([
      gh<{ id: number; state: string; commit_id: string; user: { login: string } }>("api", `repos/${repo}/pulls/${number}/reviews/${event.review.id}`),
      gh<{ number: number; html_url: string; state: string; head: { sha: string; ref: string } }>("api", `repos/${repo}/pulls/${number}`),
    ]);
    if (review.id !== event.review.id || review.user.login !== "coderabbitai[bot]" || review.state.toUpperCase() !== event.review.state.toUpperCase() || review.commit_id !== event.review.commit_id) {
      throw new Error("CodeRabbit review did not match GitHub's current record.");
    }
    if (pr.number !== number || pr.html_url !== event.pull_request.html_url) throw new Error("GitHub PR identity changed.");
    const checks = await gh<{ statusCheckRollup: Array<{ conclusion?: string; state?: string; status?: string }> | null }>(
      "pr", "view", String(number), "--repo", repo, "--json", "statusCheckRollup");
    return { url: pr.html_url, branch: pr.head.ref, head: pr.head.sha, open: pr.state === "open",
      checksPassing: (checks.statusCheckRollup ?? []).every(check =>
        ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? check.state ?? "")) };
  }
}
