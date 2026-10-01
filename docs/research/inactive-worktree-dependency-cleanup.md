# Dependency cleanup for inactive T3 worktrees

Research date: 2026-10-01. The initial research was read-only: no live worktrees or dependencies were deleted. It produced the proposal recorded below.

Implementation follow-up: the user subsequently requested a global sweep after every completed Retro. See [the implemented specification](../specs/retro-global-dependency-sweep.md). Without a shared T3 reservation, resumable terminal owners remain review-only; automatic cleanup is restricted to deleted/stopped owners after the grace period. The original proposal below records the research, rather than the final behavior.

## Recommendation

Keep the existing merged-PR/Retro worktree retirement as the primary cleanup. Add a separate dependency-only sweep for worktrees retained after retirement, or explicitly selected by the user. Select worktrees using session ownership and retirement evidence first; use age as a grace period. An old modification date alone does not establish that a worktree is inactive.

Running npkill separately inside each approved worktree is feasible for an operator in a terminal. For unattended bridge integration, use a small inventory and deletion helper with explicit paths rather than invoking the current npkill CLI.

## Published package versus development docs

The npm registry currently publishes `0.12.2` as `latest`, and `0.12.2-1` as `next`. This was verified using `npm view npkill version dist.tarball dist-tags --json`; the published `0.12.2` tarball was downloaded and inspected without executing npkill. Pin the version for any reviewed procedure. [npm registry metadata](https://registry.npmjs.org/npkill/latest), [published package](https://registry.npmjs.org/npkill/-/npkill-0.12.2.tgz).

GitHub's `main` README describes `--json`, profiles, `--config`, plural `--targets`, `--sort age`, and `--exclude-sensitive`. These are absent from the current published CLI. The website and release-tag documentation show older options. Do not use development-branch examples as commands for `npx npkill@latest`. [Development README](https://github.com/voidcosmos/npkill#options), [release CLI option definitions](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/constants/cli.constants.ts).

## What 0.12.2 actually supports

| Option | Meaning for this use case |
| --- | --- |
| `--directory PATH` | Recursively search beneath a chosen worktree; it is a search root, not an inactivity filter. |
| `--target node_modules` | Match one directory name; this is also the default. Singular `--target`, not `--targets`. |
| `--exclude "a,b"` | Exclude paths during traversal; current worker matches each string as a substring of the full path. It is not an exact worktree allowlist. |
| `--sort last-mod` | Order results by modification age; does not restrict which results are deleted. |
| `--delete-all` | Delete every discovered target, independent of age or Git/session state. |
| `-y` | Suppress npkill's bulk-deletion warning. The preceding `npx --yes` separately accepts npm's package installation prompt. |
| `--dry-run` | Replace deletion with a simulated delay; UI/logs can still label simulated results deleted. |
| `-x` | Exclude paths considered sensitive, including any path with a hidden directory segment. All paths beneath `~/.t3` match that rule. |

Release options provide no native `--older-than`, cutoff date, Git merge, PR, or active-session filter, and no JSON output or profiles/configuration feature. [Release option definitions](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/constants/cli.constants.ts), [release README](https://github.com/voidcosmos/npkill/blob/v0.12.2/README.md), [worker exclusions](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/services/files/files.worker.ts), [controller bulk deletion and dry-run](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/controller.ts).

The proposed broad command searches every worktree and removes found `node_modules`, including those in active workspaces. It does not remove Git worktrees themselves.

### Age is not inactivity

In 0.12.2, age is computed from the latest file modification in the target's parent workspace, recursively excluding `node_modules`, and stored internally in seconds. The controller suppresses that calculation for sensitive paths, setting the timestamp to `-1`; therefore worktrees under `~/.t3` do not get meaningful age values. [File timestamp implementation](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/services/files/files.service.ts), [controller stats calculation](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/controller.ts).

Development JSON documentation defines `modificationTime` in milliseconds and demonstrates an external jq date filter. That example still does not prove inactivity and is not available in npm latest. Filesystem modification time misses read-only sessions and dev servers, while checkout or generated files can change it without human activity. [Development JSON documentation](https://github.com/voidcosmos/npkill/blob/main/docs/json-output.md).

Development profiles introduce broader default Node targets such as build caches, and read configuration from the working directory/home. If adopting a future release, recheck defaults and explicitly constrain targets to `node_modules` rather than inheriting a broad profile. [Development profiles](https://github.com/voidcosmos/npkill/blob/main/docs/profiles.md), [development configuration options](https://github.com/voidcosmos/npkill#options).

### Automation and path boundaries

The published CLI checks for a TTY even with bulk-delete flags. It remains an interactive program after scanning; the completion handler does not automatically exit. It is therefore unsuitable as a direct headless bridge subprocess. [Release controller](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/controller.ts).

Its worker traverses real directory entries and skips child symlinks, but root validation uses `stat`, so a symlink supplied as the root can be followed. Traversal stops at a matched target; passing the worktree directory as root is the supported shape, rather than supplying `node_modules` itself. The Unix deletion implementation interpolates paths into a shell command. An automation helper should instead use filesystem APIs with validated exact paths. [Release worker](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/services/files/files.worker.ts), [root validation](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/services/files/files.service.ts), [Unix deletion](https://github.com/voidcosmos/npkill/blob/v0.12.2/src/services/files/unix-files.service.ts).

## Local assessment

The accompanying read-only assessment found 40 bridge sessions referencing 27 distinct worktree paths, with lifecycle counts of seven paused, sixteen closed, sixteen idle, and one running, across nine repository groups. These counts are observations, not deletion eligibility: multiple sessions can share a worktree, and manually created T3 Code threads are additional owners outside the bridge state.

A separate read-only T3 state snapshot found 210 thread references to 127 distinct worktree paths, including historical paths that may no longer exist. Nondeleted threads included five running providers and four ready providers. Match both `worktree_path` and the project's checkout root when identifying ownership; using only the bridge's records would miss other T3 activity. These changing counts are not a cleanup manifest.

`Session.updatedAt` is refreshed on observation/polling, and `lastReportAt` advances for heartbeat reports. Neither reliably identifies the last user activity. A future helper should derive activity and outstanding-work evidence from supported T3 snapshots/session APIs and bridge ownership; the initial read-only inspection also identified T3 projection fields for latest user messages, settled/unsettled state, provider sessions, completed turns, and pending input/approval counts. Do not build automatic eligibility around direct writes to the T3 database. [Observation timestamp update](../../src/bridge.ts#L665), [report timestamp update](../../src/bridge.ts#L257).

## Proposed eligibility policy

1. Inventory registered Git worktrees beneath the configured `~/.t3/worktrees` root. Associate each canonical path with all bridge sessions and T3 Code threads, providers, queued turns, and retained-worktree cleanup records that reference it.
2. Automatically nominate only positively identified retired/terminal workspaces. Start with a configurable seven-day grace period after retirement/terminal completion. Exclude workspaces with ongoing providers, queued/pending work, previews, dev servers, or any other active owner.
3. Use thirty days without reliable activity only to flag unknown, paused, cancelled, or idle workspaces for review. Age alone never authorizes their cleanup. If ownership data is missing or stale, skip automatic deletion.
4. A retained worktree with dirty/unpublished work can support an explicitly opted-in dependency-only cleanup after its owners have stopped. Preserve source, branches, `.git`, `.env`, lockfiles, configuration, and session history. Never delete tracked files inside a candidate dependency directory or follow symlink targets.
5. Validate each worktree and target against the canonical root using path containment checks, reject symlink roots/targets and nested active workspaces, and avoid crossing filesystem boundaries. Recheck ownership and target identity immediately before deletion. For the first manual batch, avoid new turns/previews in the selected folders during cleanup. Unattended execution requires a shared reservation/coordination mechanism honored by every launcher; a bridge-only lock does not control manually launched T3 turns. If that coordination is unavailable, retain report-only/manual operation.
6. Record the exact paths, eligibility evidence, estimates, skips/errors, and observed reclaimed space. Missing targets are harmless. Reopening a cleaned workspace should trigger its normal dependency installation using its package manager and lockfile.

These are proposed operational rules, not npkill features. Reliable ownership and race prevention require application state; process absence alone is insufficient for automatic eligibility.

## Delivery sequence

1. Add a report-only inventory command: show eligible, active, and unknown worktrees, terminal/last-activity dates, individual `node_modules` paths, and estimated savings. Report scan errors instead of treating an unreadable owner as inactive.
2. Review the first report, then perform one selected cleanup batch. Keep unknown workspaces as manual choices. Leave full-worktree retirement to the existing cleanup mechanism.
3. If useful, add explicit dependency-cleanup configuration and scheduling in a later implementation. Start with `node_modules` only. Exercise active owners, queued turns, reopened sessions, dirty worktrees, tracked targets, symlinks, paths with spaces/metacharacters, and interrupted sweeps in tests.

For a manually reviewed worktree, the operator can preview the bulk behavior in a terminal:

```sh
npx --yes npkill@0.12.2 --directory "/absolute/path/to/approved-worktree" --target node_modules --delete-all -y --dry-run --no-check-update
```

After approval of that worktree and a fresh inactivity check, the same command without `--dry-run` would remove its discovered dependency directories. Do not add `-x` beneath `~/.t3`, and do not invoke bulk deletion at the global worktree root. These examples were not executed.
