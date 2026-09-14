# 12: Verify the complete bridge workflow against live Linear and T3Code

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

The assembled bridge is demonstrated through a real issue-to-draft-PR workflow, follow-up, restart recovery and cancellation, with acceptance evidence recorded.

## Acceptance criteria

- [ ] Run the integrated automated suite covering signed intake, routing, deduplication, queues, context/attachments, questions/approvals, cancellation, recovery, PR lifecycle, cleanup, concurrency and secret-free reporting.
- [ ] Use real Linear and T3Code to delegate a representative issue, obtain a draft PR and update it through a follow-up.
- [ ] Restart the bridge during the exercise and verify the same thread/branch/PR is recovered without duplicate work.
- [ ] Cancel active work and verify pending prompts are cleared while changes are preserved; exercise question/approval handling and incomplete-work reporting where applicable.
- [ ] Record concrete validation evidence, integration versions observed for reproduction (not pins), and blockers. Do not claim v1 ready if required live validation has not completed.

## Blocked by

- Draft 5: Cancel active work safely and resume preserved sessions
- Draft 6: Supply refreshed Linear context and attachments with external link handoff
- Draft 7: Answer T3Code questions and approvals through Linear
- Draft 9: Clean up completed PR worktrees without discarding work
- Draft 10: Run isolated sessions under a configurable concurrency limit
- Draft 11: Provide upstream-aligned T3Code configuration and installation assets
