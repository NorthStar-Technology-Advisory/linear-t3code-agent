# 8: Deliver draft PRs and update them through same-session follow-ups

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Delegated implementation produces a reviewable draft PR and validation summary in Linear, with subsequent turns updating that PR while it remains open.

## Acceptance criteria

- [ ] Guide T3Code to implement, test, push the session branch and open a draft PR; persist and report PR identity and validation results.
- [ ] Permit useful incomplete work as a draft PR while clearly distinguishing blockers, failed checks, pre-existing failures and checks that could not run; do not report incomplete work as successful.
- [ ] Keep merge authority with a human; bridge instructions and workflow never authorize automatic merge.
- [ ] Follow-ups update the existing open PR. Once merged or closed, stop further implementation in that session and request a new delegation.
- [ ] Verify branch/PR correlation and success/incomplete reporting using temporary repositories and controlled PR service responses, including after bridge restart.

## Blocked by

- Draft 4: Queue follow-ups durably and pause them after failed turns
