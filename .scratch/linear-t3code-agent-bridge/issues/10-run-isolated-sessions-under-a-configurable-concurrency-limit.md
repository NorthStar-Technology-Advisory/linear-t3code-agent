# 10: Run isolated sessions under a configurable concurrency limit

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Independent Agent Sessions can work simultaneously in separate worktrees up to an operator-configured limit, with excess work waiting durably.

## Acceptance criteria

- [ ] Schedule runnable sessions under a configurable execution limit without allowing concurrent ordinary turns in one session.
- [ ] Ensure sessions targeting the same repository retain separate worktrees/branches and never share a mutable checkout.
- [ ] Keep waiting work durable and reconcile existing T3Code activity before allocating slots after restart.
- [ ] Respect paused/failed sessions and release execution capacity when a turn stops or finishes; lifecycle extensions must preserve this invariant.
- [ ] Verify simultaneous delegations, limit enforcement, waiting work, same-repository isolation and restart without accidental oversubscription.

## Blocked by

- Draft 4: Queue follow-ups durably and pause them after failed turns
