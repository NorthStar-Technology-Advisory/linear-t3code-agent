# 2: Delegate a mapped Linear issue to an isolated T3Code thread

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

A signed delegation creates a T3Code thread in the configured repository with its own worktree and branch, runs the initial task, and reports progress and its result in Linear.

## Acceptance criteria

- [ ] Use authenticated T3Code orchestration for one installation and instance; explicitly map Linear projects to repositories with provider/model defaults and overrides.
- [ ] Reject invalid or stale webhooks and unmapped projects without starting work. Issue content cannot override routing or credentials.
- [ ] One Agent Session owns one thread, branch and worktree; a separate delegation on the same issue gets separate identities. Initially serialize execution until configurable concurrency is delivered.
- [ ] Send initial issue title/description and preserve external URLs; report start, progress, completion and authentication/orchestration failures in Linear.
- [ ] Use full execution permissions with the documented dedicated-account assumption; keep secrets server-side and redact logs/activities. Impose no execution deadline or T3Code version pin.
- [ ] Verify the complete delegation path using controlled Linear/T3Code services and temporary repositories.

## Blocked by

- Draft 1: Introduce a runner boundary without changing the Linear workflow
