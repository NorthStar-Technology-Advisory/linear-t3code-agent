import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { git } from "./repository.js";
import type { WorkspaceInventory } from "./runner.js";

const exec = promisify(execFile);
const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`);
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
async function ownerPath(value: string): Promise<string> {
  try { return await realpath(value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(value); throw error; }
}
export type SweepEntry = { worktree: string; outcome: "removed" | "review" | "skipped" | "error"; detail: string };
export type SweepResult = { worktrees: number; removed: number; entries: SweepEntry[] };
export type SweepOptions = {
  root: string; graceMs: number;
  inventory(): Promise<WorkspaceInventory>;
  protectedPaths(): string[];
  processPaths?: () => Promise<string[]>;
};

/** Read both open files/cwds and command lines: previews can run outside the bridge. */
export async function localProcessPaths(): Promise<string[]> {
  if (!process.getuid) throw new Error("Local process inventory unsupported.");
  const [files, commands] = await Promise.all([
    exec("lsof", ["-n", "-P", "-F", "n", "-u", String(process.getuid())], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }),
    exec("ps", ["-ww", "-axo", "command="], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
  ]);
  return [...files.stdout.split("\n").filter(line => line.startsWith("n/")).map(line => line.slice(1)), ...commands.stdout.split("\n")];
}

async function directories(root: string, worktrees: string[], notices: SweepEntry[]) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".dependency-sweep-")) continue;
    const folder = path.join(root, entry.name);
    if (entry.isSymbolicLink()) { notices.push({ worktree: folder, outcome: "skipped", detail: "Symlink folder preserved." }); continue; }
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let marker;
    try { marker = await lstat(path.join(folder, ".git")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (marker) {
      if (marker.isFile()) worktrees.push(folder);
      else notices.push({ worktree: folder, outcome: "skipped", detail: "Source checkout or symlink Git metadata preserved." });
    } else await directories(folder, worktrees, notices);
  }
}

async function dependencies(folder: string, targets: string[]) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const target = path.join(folder, entry.name);
    if (entry.name === "node_modules") targets.push(target);
    else {
      // A nested checkout has independent owners and must never be traversed.
      try { await lstat(path.join(target, ".git")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await dependencies(target, targets);
      }
    }
  }
}

async function validateCacheFilesystem(folder: string, device: number) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // Internal package symlinks are removed as links, never traversed.
    const child = path.join(folder, entry.name);
    const identity = await lstat(child);
    if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== device) throw new Error("Dependency cache crosses a filesystem or changed during scan.");
    await validateCacheFilesystem(child, device);
  }
}

async function decision(worktree: string, options: SweepOptions, detached?: string): Promise<{ outcome: "remove" | "review" | "skipped"; detail: string }> {
  const inventory = await options.inventory();
  const projects = new Map(await Promise.all(inventory.projects.map(async project => [project.id, await ownerPath(project.workspaceRoot)] as const)));
  if (inventory.threads.some(thread => !projects.has(thread.projectId))) throw new Error("Incomplete project ownership inventory.");
  if ([...projects.values()].some(root => overlaps(root, worktree))) return { outcome: "skipped", detail: "Project checkout owns this path." };
  const ownerPaths = await Promise.all(inventory.threads.map(thread => ownerPath(thread.worktreePath ?? projects.get(thread.projectId)!)));
  const owners = inventory.threads.filter((_thread, index) => overlaps(ownerPaths[index]!, worktree));
  if (!owners.length) return { outcome: "skipped", detail: "Unknown T3 ownership; age alone does not authorize cleanup." };
  if (options.protectedPaths().some(owner => overlaps(path.resolve(owner), worktree))) return { outcome: "skipped", detail: "Bridge session has retained or pending work." };
  if (owners.some(owner => owner.latestTurn?.state === "running" || owner.session && (owner.session.status !== "stopped" || owner.session.activeTurnId))) return { outcome: "skipped", detail: "T3 provider or turn remains active." };
  const terminal = owners.map(owner => owner.deletedAt ?? owner.archivedAt ?? owner.settledAt);
  if (terminal.some(date => !date || !Number.isFinite(Date.parse(date)))) return { outcome: "skipped", detail: "Owner is not positively terminal." };
  const activity = owners.flatMap((owner, index) => [terminal[index]!, owner.updatedAt ?? ""]);
  if (activity.some(date => !Number.isFinite(Date.parse(date)))) return { outcome: "skipped", detail: "Owner activity date unavailable." };
  const lastActivity = Math.max(...activity.map(date => Date.parse(date)));
  if (Date.now() - lastActivity < options.graceMs) return { outcome: "skipped", detail: `Seven-day/configured grace period; last owner activity ${new Date(lastActivity).toISOString()}.` };
  const processPaths = await (options.processPaths ?? localProcessPaths)();
  if (processPaths.some(value => value.includes(worktree) || detached && value.includes(detached))) return { outcome: "skipped", detail: "Local process/open file uses this worktree or its detached cache." };
  if (owners.some(owner => !owner.deletedAt)) return { outcome: "review", detail: "Stopped terminal owners can still resume; manual review required without a shared T3 reservation." };
  return { outcome: "remove", detail: `All ${owners.length} T3 owners deleted and stopped; last activity ${new Date(lastActivity).toISOString()}.` };
}

/** Global root scan; unknown ownership and integration failures always preserve files. */
export async function sweepDependencies(options: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { worktrees: 0, removed: 0, entries: [] };
  const root = path.resolve(options.root);
  try {
    if (root === path.parse(root).root || !Number.isFinite(options.graceMs) || options.graceMs < 7 * 86400000) throw new Error("Specific sweep root and at least seven days of grace required.");
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) throw new Error("Sweep root must be a canonical directory without symlink ancestors.");
    // Fail before scanning/deleting if the global ownership contract is unavailable.
    await options.inventory();
    const worktrees: string[] = [];
    await directories(root, worktrees, result.entries);
    result.worktrees = worktrees.length;
    for (const worktree of worktrees) {
      try {
        const worktreeStat = await lstat(worktree);
        if (await realpath(worktree) !== worktree || worktreeStat.dev !== rootStat.dev || await git(worktree, "rev-parse", "--show-toplevel") !== worktree ||
            !(await git(worktree, "worktree", "list", "--porcelain", "-z")).includes(`worktree ${worktree}\0`) ||
            await git(worktree, "rev-parse", "--git-dir") === await git(worktree, "rev-parse", "--git-common-dir")) throw new Error("Not a canonical linked worktree on the sweep filesystem.");
        const eligibility = await decision(worktree, options);
        if (eligibility.outcome === "skipped") { result.entries.push({ worktree, outcome: "skipped", detail: eligibility.detail }); continue; }
        const targets: string[] = [];
        await dependencies(worktree, targets);
        if (!targets.length) { result.entries.push({ worktree, outcome: "skipped", detail: "No dependency directories." }); continue; }
        if (eligibility.outcome !== "remove") { result.entries.push({ worktree, outcome: eligibility.outcome, detail: `${eligibility.detail} ${targets.length} dependency directory(s) preserved.` }); continue; }
        if (await git(worktree, "status", "--porcelain", "--untracked-files=all")) {
          result.entries.push({ worktree, outcome: "review", detail: "Dirty or untracked local work preserved; dependency cleanup needs manual review." }); continue;
        }
        for (const target of targets) {
          if (await git(worktree, "ls-files", "--", path.relative(worktree, target))) {
            result.entries.push({ worktree, outcome: "skipped", detail: `Tracked dependency contents preserved: ${target}` }); continue;
          }
          const identity = await lstat(target);
          if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== rootStat.dev || await realpath(target) !== target || !inside(worktree, target)) throw new Error("Dependency target identity changed.");
          const fresh = await decision(worktree, options);
          if (fresh.outcome !== "remove") { result.entries.push({ worktree, outcome: "skipped", detail: `Recheck preserved ${target}: ${fresh.detail}` }); break; }
          const checked = await lstat(target);
          if (checked.ino !== identity.ino || checked.dev !== identity.dev || await realpath(target) !== target) throw new Error("Dependency target changed during recheck.");
          if (await git(worktree, "status", "--porcelain", "--untracked-files=all") || await git(worktree, "ls-files", "--", path.relative(worktree, target))) throw new Error("Local Git state changed during recheck.");
          await validateCacheFilesystem(target, rootStat.dev);
          // Detach the exact cache before deletion. A new install at the original
          // path cannot be recursively deleted by this operation.
          const staging = await mkdtemp(path.join(root, ".dependency-sweep-"));
          const detached = path.join(staging, "node_modules");
          let moved = false;
          try {
            await rename(target, detached); moved = true;
            // The original parent must still designate the same workspace.
            if (await realpath(worktree) !== worktree || await realpath(path.dirname(target)) !== path.dirname(target)) throw new Error("Workspace path changed during detach.");
            const afterMove = await decision(worktree, options, staging);
            if (afterMove.outcome !== "remove" || options.protectedPaths().some(owner => overlaps(path.resolve(owner), worktree)) || await git(worktree, "status", "--porcelain", "--untracked-files=all")) throw new Error("Ownership or Git state changed after detaching cache.");
            const detachedIdentity = await lstat(detached);
            if (detachedIdentity.ino !== identity.ino || detachedIdentity.dev !== identity.dev) throw new Error("Detached target identity changed.");
            await rm(detached, { recursive: true }); moved = false;
            result.removed++;
            result.entries.push({ worktree, outcome: "removed", detail: `${target} — ${fresh.detail}` });
          } catch {
            if (moved) {
              try {
                await lstat(target);
                result.entries.push({ worktree, outcome: "error", detail: `Cache retained at ${detached}; original path was recreated. Review recovery manually.` });
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT" && await realpath(path.dirname(target)) === path.dirname(target)) { await rename(detached, target); moved = false; }
                else throw error;
              }
            }
            result.entries.push({ worktree, outcome: "error", detail: `Cleanup interrupted; preserved/restored dependency directory ${target}.` });
          } finally {
            if (!moved) await rm(staging, { recursive: true });
          }
        }
      } catch {
        result.entries.push({ worktree, outcome: "error", detail: "Preserved: filesystem, Git, ownership or process verification failed." });
      }
    }
    // A crash can leave a detached cache; never guess ownership or erase it.
    for (const entry of await readdir(root)) if (entry.startsWith(".dependency-sweep-")) result.entries.push({ worktree: path.join(root, entry), outcome: "review", detail: "Interrupted cleanup cache retained; manual recovery required." });
  } catch {
    result.entries.push({ worktree: root, outcome: "error", detail: "Sweep unavailable; root or complete T3 inventory could not be verified. All remaining files preserved." });
  }
  return result;
}

export function sweepReport(result: SweepResult): string {
  return `Retro dependency sweep: scanned ${result.worktrees} worktrees across all repository folders; removed ${result.removed} node_modules directories. Source files and Git worktrees retained.\n\n` +
    result.entries.map(entry => `${entry.outcome}: ${entry.worktree}\n${entry.detail}`).join("\n\n");
}
