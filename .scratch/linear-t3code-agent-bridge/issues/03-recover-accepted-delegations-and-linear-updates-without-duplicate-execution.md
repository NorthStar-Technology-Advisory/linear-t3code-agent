# 3: Recover accepted delegations and Linear updates without duplicate execution

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Repeated webhooks and bridge restarts preserve one accepted delegation and reconnect to the existing T3Code work rather than creating or running it again.

## Acceptance criteria

- [ ] Persist validated intake and deduplication identity before acknowledging success; repeated initial deliveries create exactly one logical session.
- [ ] Durably retain workspace/team, issue, Agent Session, T3Code project/thread, repository/worktree/branch, provider/model, lifecycle and timestamps.
- [ ] Correlate remote commands and record uncertain acceptance; reconcile rather than blindly resubmitting after an ambiguous response or crash.
- [ ] Recover snapshots and replay missed events; persist enough outbound Linear update state to recover reporting failures without contradictory results.
- [ ] Inject crashes around persistence, remote acceptance and reporting; prove no duplicate initial work and useful secret-free failure reporting.

## Blocked by

- Draft 2: Delegate a mapped Linear issue to an isolated T3Code thread
