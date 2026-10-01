# Global dependency sweep after Retro

Completed Retro handovers should trigger disk-space maintenance across every repository folder beneath the configured T3 worktree root. Existing merged-ticket retirement remains the primary cleanup and continues to remove whole eligible worktrees. The global sweep removes only disposable dependencies in other eligible retained worktrees.

## Trigger and delivery

- Queue a sweep durably after each successful retrospective completion, for both comment and agent-managed outputs, even without an associated merged PR. Coalesce pending sweeps for the same Agent Session.
- Deliver its complete handover to Linear, then confirm the originating provider has stopped before scanning. Pending follow-ups, questions, publication and execution take precedence. Incomplete or paused retrospectives do not schedule a new sweep.
- Scan all repository folders beneath `DEPENDENCY_SWEEP_ROOT`, defaulting to the bridge user's canonical `~/.t3/worktrees`. Empty configuration disables the sweep. This is a Retro-triggered operation, not a weekly job.
- Preserve existing retirement behavior. Publish a detailed sidebar report containing scan/removal counts, exact paths, eligibility dates, skips, review candidates and errors. Report-only failures finish the sweep; a later completed Retro performs a new scan.

## Eligibility and safe removal

- Inventory all T3 projects and threads, including manual, deleted and archived owners. Resolve path aliases and protect intersecting parent/child workspaces. Missing ownership, missing dates and failed inventories never establish inactivity.
- Automatically remove only when all owners are deleted and stopped, no turn is running, and both terminal and last owner update dates exceed a configurable grace period of at least seven days. Retained bridge sessions protect their worktrees unless closed/retired and without outstanding work.
- Settled or archived stopped threads remain review-only because they can resume and T3 lacks a shared reservation honored by manual launchers. Idle, paused, cancelled, unknown and recent workspaces remain protected regardless of age. This deliberately narrows the original automatic-terminal-workspace proposal.
- Check local open files/cwds and process command lines to preserve previews and dev servers outside bridge ownership. If process inspection is unavailable or fails, preserve candidates.
- Require a clean, canonical, registered linked Git worktree on the root filesystem. Preserve source checkouts, tracked dependencies, dirty/untracked work, symlink folders/targets, nested checkouts and dependency caches crossing filesystem boundaries. Leave source, `.git`, configuration, lockfiles, branches and conversation history untouched.
- Discover root and nested-package `node_modules` directories without following symlinks. Recheck owner, bridge, process, target identity and Git state before removal. Detach each approved directory into a unique root staging folder, recheck again, then delete that detached directory. A newly installed directory at the original path cannot be included in recursive deletion.
- Restore a detached cache when a post-detachment check fails and the original path remains free. If restoration is unsafe or a crash interrupts cleanup, retain and report the staging directory for manual recovery. Do not automatically erase unknown staging contents.
- These checks reduce races but do not provide a universal filesystem/launcher lock. Never claim that a bridge-only lock protects manual T3 activity. Resumable-owner cleanup requires manual coordination or a future shared reservation API.
- Use filesystem APIs with explicit validated paths; do not execute the interactive npkill CLI. Reopening a cleaned workspace requires normal package-manager installation from its lockfile.

## Validation

Temporary Git repositories and the signed Linear/T3 integration harness must demonstrate cross-project cleanup, publication/provider ordering, durable restart recovery, no cleanup after incomplete Retro, and preservation for active/manual/unknown/recent owners, tracked dependencies, dirty sources, path aliases, symlinks, process inspection failures and reactivation during detachment. Live cleanup is a separate deployment acceptance step.
