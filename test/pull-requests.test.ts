import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { cleanupWorktree, type PullRequest } from "../src/pull-requests.js";
import type { Route } from "../src/repository.js";

async function mergedWorkspace(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "retirement-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo"), origin = path.join(root, "origin.git"), worktree = path.join(root, "task");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test"); git(repository, "config", "user.email", "test@example.com");
  await writeFile(path.join(repository, ".gitignore"), "node_modules/\n.next/\n.turbo/\ncoverage/\n.env\n");
  git(repository, "add", ".gitignore"); git(repository, "commit", "-m", "Initial");
  execFileSync("git", ["init", "--bare", origin], { stdio: "pipe" });
  git(repository, "remote", "add", "origin", origin); git(repository, "push", "origin", "main");
  git(repository, "worktree", "add", "-b", "task", worktree);
  await writeFile(path.join(worktree, "feature.txt"), "Delivered work");
  git(worktree, "add", "feature.txt"); git(worktree, "commit", "-m", "Feature");
  const headRefOid = git(worktree, "rev-parse", "HEAD");
  git(worktree, "push", "origin", "task", "HEAD:refs/pull/42/head");
  git(repository, "merge", "--squash", "task"); git(repository, "commit", "-m", "Squashed feature");
  git(repository, "push", "origin", "main"); git(repository, "push", "origin", "--delete", "task");
  const route: Route = { repository, t3ProjectId: "test", workspaceMode: "worktree", baseBranch: "main", startFromOrigin: true, modelSelection: { instanceId: "codex", model: "test" } };
  const pr: PullRequest = { number: 42, url: "https://github.com/test/repo/pull/42", headRefName: "task", headRefOid, state: "MERGED", isDraft: false };
  return { root, repository, worktree, route, pr, git };
}

test("merged PR proof removes a squash-merged worktree after remote branch deletion", async t => {
  const f = await mergedWorkspace(t);
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "task"), /fully pushed worktree removed/);
  await assert.rejects(access(f.worktree));
  assert.equal(f.git(f.repository, "rev-parse", "task"), f.pr.headRefOid);
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "task"), /already removed/);
});

test("merged cleanup removes explicitly disposable ignored dependencies and caches", async t => {
  const f = await mergedWorkspace(t);
  for (const directory of ["node_modules", ".next", ".turbo", "coverage"]) {
    await mkdir(path.join(f.worktree, directory)); await writeFile(path.join(f.worktree, directory, "generated"), "cache");
  }
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "task"), /worktree removed/);
  await assert.rejects(access(f.worktree));
});

test("merged cleanup preserves ignored configuration and untracked files", async t => {
  const f = await mergedWorkspace(t);
  await writeFile(path.join(f.worktree, ".env"), "private configuration");
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "task"), /ignored local files remain/);
  await rm(path.join(f.worktree, ".env"));
  await writeFile(path.join(f.worktree, "notes.txt"), "Local notes");
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "task"), /untracked changes remain/);
  await access(f.worktree);
});

test("merged cleanup preserves commits made after the published PR head", async t => {
  const f = await mergedWorkspace(t);
  await writeFile(path.join(f.worktree, "later.txt"), "Unpublished work");
  f.git(f.worktree, "add", "later.txt"); f.git(f.worktree, "commit", "-m", "Unpublished");
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "task"), /not contained in the verified merged PR head/);
  await access(f.worktree);
});

test("merged cleanup requires matching remote PR proof and saved workspace identity", async t => {
  const f = await mergedWorkspace(t);
  assert.match(await cleanupWorktree(f.route, f.worktree, { ...f.pr, headRefOid: f.git(f.repository, "rev-parse", "main") }, "task"), /not contained/);
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "unexpected"), /branch no longer matches/);
  assert.match(await cleanupWorktree(f.route, f.repository, f.pr, "main"), /source checkout/);
  await access(f.worktree); await access(f.repository);
});

test("closure without a verified merge retains ignored dependencies", async t => {
  const f = await mergedWorkspace(t);
  await mkdir(path.join(f.worktree, "node_modules")); await writeFile(path.join(f.worktree, "node_modules", "generated"), "cache");
  assert.match(await cleanupWorktree(f.route, f.worktree), /ignored local files remain/);
  await access(f.worktree);
});

test("a new workspace owner prevents removal after Git verification", async t => {
  const f = await mergedWorkspace(t);
  assert.match(await cleanupWorktree(f.route, f.worktree, f.pr, "task", () => false), /new turn owns the workspace/);
  await access(f.worktree);
});
