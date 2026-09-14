# 9: Clean up completed PR worktrees without discarding work

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Closed or merged PRs release clean worktrees automatically while uncommitted or unpushed changes remain available and are reported.

## Acceptance criteria

- [ ] Observe persisted PR lifecycle and attempt cleanup only after merge or closure, never while the session still has active repository work.
- [ ] Remove eligible clean worktrees only after confirming no uncommitted or unpushed work remains.
- [ ] Preserve and report cleanup exceptions; make repeated observation and cleanup safe across restarts.
- [ ] Retain the Linear Agent Session-to-T3Code mapping and enforce the new-delegation requirement for further implementation.
- [ ] Verify open, closed and merged PR cases with clean, dirty and unpushed repositories and repeated cleanup attempts.

## Blocked by

- Draft 8: Deliver draft PRs and update them through same-session follow-ups
