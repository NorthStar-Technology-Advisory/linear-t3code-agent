# 4: Queue follow-ups durably and pause them after failed turns

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Every ordinary follow-up reaches the same T3Code conversation in order, survives restarts, and waits for an explicit resume when an agent turn fails.

## Acceptance criteria

- [ ] Replace the single pending-payload slot with a durable ordered queue and deduplicate repeated follow-up deliveries.
- [ ] Only submit the next ordinary prompt after the current turn finishes, retaining fixed repository/provider/model and the same thread/worktree/branch.
- [ ] Persist queued and uncertain submissions and reconcile them during restart without replaying accepted work.
- [ ] On agent failure report the error, preserve and pause pending prompts, and resume only through an explicit resume action; retry temporary connection failures safely.
- [ ] Verify multiple queued messages, duplicate delivery, restart during dispatch and failure/resume through the shared end-to-end boundary.

## Blocked by

- Draft 3: Recover accepted delegations and Linear updates without duplicate execution
