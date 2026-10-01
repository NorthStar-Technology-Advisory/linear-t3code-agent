import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sweepDependencies, type SweepOptions } from "../src/dependency-sweep.js";
import type { WorkspaceInventory, WorkspaceOwner } from "../src/runner.js";

const old = "2020-01-01T00:00:00.000Z";
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dependency-sweep-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "source");
  const sweepRoot = path.join(root, "worktrees");
  await mkdir(repo); await mkdir(sweepRoot);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n.env\n");
  await writeFile(path.join(repo, "source.txt"), "Keep the source");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial");
  const inventory: WorkspaceInventory = { projects: [{ id: "project", workspaceRoot: repo }], threads: [] };
  const options: SweepOptions = { root: sweepRoot, graceMs: 7 * 86400000, inventory: async () => inventory, protectedPaths: () => [], processPaths: async () => [] };
  async function worktree(name: string, group = "repo-one") {
    const folder = path.join(sweepRoot, group, name);
    await mkdir(path.dirname(folder), { recursive: true });
    git("worktree", "add", "-b", name, folder);
    const owner: WorkspaceOwner = { id: name, projectId: "project", worktreePath: folder, deletedAt: old, archivedAt: null, settledAt: null, updatedAt: old, latestTurn: null, session: { status: "stopped", lastError: null, activeTurnId: null } };
    inventory.threads.push(owner);
    const target = path.join(folder, "node_modules");
    await mkdir(target); await writeFile(path.join(target, "package.js"), "Disposable");
    return { folder, owner, target };
  }
  return { root, repo, sweepRoot, inventory, options, worktree };
}

test("global sweep removes dependencies across repository groups and nested packages, retaining all source and local configuration", async t => {
  const f = await fixture(t);
  const first = await f.worktree("first");
  const second = await f.worktree("second", "another-repo");
  const nested = path.join(second.folder, "packages", "app", "node_modules");
  await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, "dep.js"), "Disposable");
  await writeFile(path.join(second.folder, ".env"), "Retain configuration");
  const result = await sweepDependencies(f.options);
  assert.equal(result.worktrees, 2); assert.equal(result.removed, 3);
  await assert.rejects(realpath(first.target)); await assert.rejects(realpath(second.target)); await assert.rejects(realpath(nested));
  assert.equal(await readFile(path.join(first.folder, "source.txt"), "utf8"), "Keep the source");
  assert.equal(await readFile(path.join(second.folder, ".env"), "utf8"), "Retain configuration");
  assert.ok(await realpath(path.join(first.folder, ".git")));
});

test("active, recent, resumable, unknown, bridge-owned and process-owned worktrees are preserved", async t => {
  const f = await fixture(t);
  const active = await f.worktree("active"); active.owner.session!.status = "running";
  const recent = await f.worktree("recent"); recent.owner.updatedAt = new Date().toISOString();
  const resumable = await f.worktree("resumable"); resumable.owner.deletedAt = null; resumable.owner.settledAt = old;
  const unknown = await f.worktree("unknown"); f.inventory.threads = f.inventory.threads.filter(owner => owner.id !== unknown.owner.id);
  const bridge = await f.worktree("bridge"); f.options.protectedPaths = () => [bridge.folder];
  const process = await f.worktree("process"); f.options.processPaths = async () => [`node ${process.target}/server.js`];
  const result = await sweepDependencies(f.options);
  assert.equal(result.removed, 0); assert.equal(result.worktrees, 6);
  assert.equal(result.entries.find(entry => entry.worktree === resumable.folder)?.outcome, "review");
  for (const item of [active, recent, resumable, unknown, bridge, process]) assert.equal(await readFile(path.join(item.target, "package.js"), "utf8"), "Disposable");
});

test("a second manual T3 owner, including symlink aliases, protects an otherwise eligible worktree", async t => {
  const f = await fixture(t); const item = await f.worktree("shared");
  const alias = path.join(f.root, "alias"); await symlink(item.folder, alias);
  f.inventory.threads.push({ ...item.owner, id: "manual", worktreePath: alias, deletedAt: null, session: { status: "ready", activeTurnId: null, lastError: null } });
  assert.equal((await sweepDependencies(f.options)).removed, 0);
  assert.ok(await realpath(item.target));
});

test("tracked dependency files, dirty sources and source checkouts are preserved", async t => {
  const f = await fixture(t); const tracked = await f.worktree("tracked"); const dirty = await f.worktree("dirty");
  execFileSync("git", ["-C", tracked.folder, "add", "-f", "node_modules/package.js"]);
  execFileSync("git", ["-C", tracked.folder, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Tracked dependency"]);
  await writeFile(path.join(dirty.folder, "source.txt"), "Local changes");
  const result = await sweepDependencies(f.options);
  assert.equal(result.removed, 0); assert.match(result.entries.map(entry => entry.detail).join("\n"), /Tracked dependency contents/);
  assert.equal(await readFile(path.join(dirty.folder, "source.txt"), "utf8"), "Local changes");
  f.options.root = f.root;
  const second = await sweepDependencies(f.options);
  assert.ok(second.entries.some(entry => entry.worktree === f.repo && entry.detail.includes("Source checkout")));
});

test("symlink roots, worktrees and dependency targets never reach their destination", async t => {
  const f = await fixture(t); const item = await f.worktree("linked");
  const outside = path.join(f.root, "outside"); await renameTarget();
  async function renameTarget() { await rm(item.target, { recursive: true }); await mkdir(outside); await writeFile(path.join(outside, "package.js"), "Keep outside"); await symlink(outside, item.target); }
  await symlink(item.folder, path.join(f.sweepRoot, "worktree-link"));
  const result = await sweepDependencies(f.options); assert.equal(result.removed, 0);
  assert.equal(await readFile(path.join(outside, "package.js"), "utf8"), "Keep outside");
  const alias = path.join(f.root, "root-link"); await symlink(f.sweepRoot, alias);
  f.options.root = alias;
  assert.equal((await sweepDependencies(f.options)).entries[0]!.outcome, "error");
});

test("ownership reactivation after detachment restores the cache", async t => {
  const f = await fixture(t); const item = await f.worktree("reopened");
  let probes = 0;
  f.options.inventory = async () => {
    if (++probes === 4) item.owner.session!.status = "running";
    return f.inventory;
  };
  const result = await sweepDependencies(f.options);
  assert.equal(result.removed, 0);
  assert.ok(result.entries.some(entry => entry.outcome === "error"));
  assert.equal(await readFile(path.join(item.target, "package.js"), "utf8"), "Disposable");
  assert.ok(!(await readdir(f.sweepRoot)).some(name => name.startsWith(".dependency-sweep-")));
});

test("unavailable ownership or process inventories preserve dependencies and report errors", async t => {
  const f = await fixture(t); const item = await f.worktree("unverified");
  f.options.processPaths = async () => { throw new Error("process inventory unavailable"); };
  let result = await sweepDependencies(f.options); assert.equal(result.removed, 0); assert.equal(result.entries[0]!.outcome, "error");
  f.options.inventory = async () => { throw new Error("T3 offline"); };
  result = await sweepDependencies(f.options); assert.equal(result.removed, 0); assert.equal(result.worktrees, 0);
  assert.equal(await readFile(path.join(item.target, "package.js"), "utf8"), "Disposable");
});

test("an install recreated after cache detachment survives cleanup", async t => {
  const f = await fixture(t); const item = await f.worktree("reinstalled");
  let probes = 0;
  f.options.inventory = async () => {
    if (++probes === 4) {
      await mkdir(item.target); await writeFile(path.join(item.target, "new.js"), "New install");
    }
    return f.inventory;
  };
  const result = await sweepDependencies(f.options);
  assert.equal(result.removed, 1);
  assert.equal(await readFile(path.join(item.target, "new.js"), "utf8"), "New install");
  await assert.rejects(readFile(path.join(item.target, "package.js")));
});

test("interrupted staging directories are retained and reported without blind deletion", async t => {
  const f = await fixture(t);
  const staging = path.join(f.sweepRoot, ".dependency-sweep-interrupted");
  await mkdir(staging); await writeFile(path.join(staging, "recover.txt"), "Keep for recovery");
  const result = await sweepDependencies(f.options);
  assert.equal(result.removed, 0); assert.ok(result.entries.some(entry => entry.worktree === staging && entry.outcome === "review"));
  assert.equal(await readFile(path.join(staging, "recover.txt"), "utf8"), "Keep for recovery");
});
