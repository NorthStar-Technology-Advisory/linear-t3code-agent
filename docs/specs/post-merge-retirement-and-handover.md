# Post-merge worktree retirement and detailed handovers

Merged tickets should release local checkout space without losing unfinished work or retrospective evidence. PR delivery should repair conflicts during agent turns, and retrospective handovers should contain actionable findings.

## Worktree retirement

- Complete the Retro handover before retiring its workspaces, including when Linear reuses the implementation Agent Session. A fresh Retro delegation can use a separate workspace.
- Queue retirement durably for the ticket's recorded implementation and Retro worktrees. Wait for queued turns, active execution, cancellation and artifact publication. Confirm all recorded providers using each workspace have stopped before removal.
- Reverify the merged PR identity through GitHub before each cleanup attempt. Validate the source checkout and recorded branch, preserving the source checkout itself.
- Preserve tracked modifications, untracked files, ignored local configuration and unpublished commits. After a verified merge, ignored files inside `node_modules`, `.next`, `.turbo` and `coverage` directories are disposable; other ignored files still block cleanup.
- If commits are no longer reachable from current origin branches after a squash/rebase merge or branch deletion, fetch the matching remote PR head. Require its SHA to match the GitHub-verified head and contain every local HEAD commit.
- Retry blocked or failed retirement across restarts; report changed outcomes without repeatedly posting identical notices. Retain local branches, conversation history and PR associations.
- Later Retro questions may allocate a fresh disposable workspace while retaining earlier conversation references. A retired merged ticket cannot resume implementation.

## Conflict resolution during PR delivery

- Fetch and integrate the actual PR target branch before creating/updating the PR. Resolve conflicts according to the task and both changes' intent, then rerun relevant checks, commit and push normally.
- Verify the open PR's mergeability after pushing. Retry an unknown result briefly; report unresolved conflicts, ambiguous decisions, failed required checks or unavailable verification as incomplete.
- Do not force-push, blindly select one side, or merge the PR itself.
- These instructions run during delivery turns and follow-ups. Background detection of conflicts introduced after a completed turn is outside this change.

## Retrospective handover

- Recognize Retro status, the required `retro` skill and an explicit `$retro` status prompt.
- Ask for priority, evidence, impact, recommended changes and their rationale, successes, unresolved questions and next decisions. Distinguish proposed changes from applied changes and disclose unavailable sources.
- Preserve the complete human-readable findings in both the comment-based publication and Agent Session handover. Do not truncate agent-managed Retro responses to 2,000 characters or discard detailed prose in favor of a short structured summary.
- Strip machine-readable result blocks. Use the existing activity chunking for long handovers.

Validation uses temporary repositories with a bare origin and the signed Linear/T3Code integration harness. Live service acceptance is separate.
