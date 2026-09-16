import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { matchProject } from "../src/project-routing.js";
import { ticketBranch } from "../src/repository.js";

test("grouped clones resolve deterministically across SSH and HTTPS origins; unrelated repositories pause", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ticket-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projects = [];
  for (const name of ["zenith2", "zenith"]) {
    const workspaceRoot = path.join(root, name);
    await mkdir(workspaceRoot);
    execFileSync("git", ["init", "-b", "main", workspaceRoot]);
    execFileSync("git", ["-C", workspaceRoot, "remote", "add", "origin", name === "zenith" ? "git@github.com:example/zenith.git" : "https://github.com/example/zenith"]);
    projects.push({ id: name, title: "NS-Zenith", workspaceRoot, deletedAt: null, defaultModelSelection: null });
  }
  assert.equal((await matchProject(projects, "NS-Zenith")).id, "zenith");
  assert.equal((await matchProject([...projects].reverse(), "NS-Zenith")).id, "zenith");
  execFileSync("git", ["-C", projects[0]!.workspaceRoot, "remote", "set-url", "origin", "https://github.com/example/unrelated.git"]);
  await assert.rejects(matchProject(projects, "NS-Zenith"), /Cannot verify a shared repository/);
});

test("grouped paths sharing Git metadata need no origin", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "ticket-common-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]);
  const checkout = path.join(root, "checkout");
  execFileSync("git", ["-C", root, "worktree", "add", "-b", "other", checkout]);
  const projects = [root, checkout].map((workspaceRoot, index) => ({ id: String(index), title: "Grouped", workspaceRoot, deletedAt: null, defaultModelSelection: null }));
  assert.equal((await matchProject(projects, "Grouped")).workspaceRoot, root);
});

test("ticket branches normalize punctuation and bound long titles", () => {
  assert.equal(ticketBranch("NOR-228", "Test issue to test T3Code connectivity"), "t3code/nor-228-test-issue-to-test-t3code-connectivity");
  assert.equal(ticketBranch("NOR-1", "  Café / [fix].. @{now}  "), "t3code/nor-1-cafe-fix-now");
  assert.equal(ticketBranch("NOR-1", "🔥"), "t3code/nor-1");
  assert.ok(ticketBranch("NOR-1", "long ".repeat(100)).length < 120);
});
