# 7: Answer T3Code questions and approvals through Linear

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Blocked T3Code questions and approval requests appear in Linear and receive correctly correlated responses while unrelated prompts stay queued.

## Acceptance criteria

- [ ] Translate native user-input and approval requests into Linear elicitation with durable request correlation.
- [ ] Send answers through the dedicated T3Code response operations instead of ordinary prompt submission.
- [ ] Require explicit approval decisions; unrelated or ambiguous text must not grant approval and must not be mistaken for a question answer.
- [ ] Keep ordinary follow-ups queued; recover outstanding requests and uncertain response acceptance after restart without duplicate answers.
- [ ] Never expire unanswered requests. Verify multiple requests, free-text/options responses, ambiguity, restart, and continued work after a valid answer.

## Blocked by

- Draft 4: Queue follow-ups durably and pause them after failed turns
