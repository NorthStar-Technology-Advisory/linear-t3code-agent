# 5: Cancel active work safely and resume preserved sessions

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

A Linear stop interrupts T3Code and clears queued prompts while preserving work for inspection or later resumption.

## Acceptance criteria

- [ ] Recognize Linear's actual stop signal and supported stop commands, including when ordinary prompts are queued.
- [ ] Interrupt current execution, clear pending prompts durably, and report whether work was stopped or no active work remained.
- [ ] Preserve changes, branch, worktree, PR if present and thread identity; a later prompt can resume the session subject to any PR lifecycle gate.
- [ ] Prevent late completion or stale events from overriding cancellation or a newer run; recover cancellation consistently after restart.
- [ ] Verify stop-versus-completion races, duplicate stop delivery, restart during stop and later resumption without losing edits.

## Blocked by

- Draft 4: Queue follow-ups durably and pause them after failed turns
