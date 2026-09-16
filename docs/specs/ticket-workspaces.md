# Ticket-owned workspaces

A Linear ticket owns one branch and isolated Git worktree. Agent Sessions and T3Code threads are conversations within that workspace, not workspace identities.

- New tickets create `t3code/<lowercase-identifier>-<title-slug>`, for example `t3code/nor-228-test-issue-to-test-t3code-connectivity`. Persist the name before remote creation; later title changes preserve it.
- Use T3Code worktree bootstrap and setup, retaining its base-branch and start-from-origin behavior. Override current-checkout preferences for new tickets.
- Status transitions, follow-ups, restarts and replacement delegations retain the branch, files and PR. Replacements wait for provider stop and validate the recorded workspace before starting a new conversation.
- Durable session history is the workspace ledger keyed by Linear workspace and issue. Existing worktrees keep their historical branch names. Legacy local checkouts are preserved and cannot silently transfer into the new mode.
- Grouped T3Code project titles may identify multiple checkouts of the same repository. Verify shared Git metadata or equivalent origin URLs; select a deterministic source path and pin it for the ticket. Unrelated, inaccessible or ambiguous repositories pause.
- Existing unowned branches and missing/unverified worktrees pause without overwriting files or allocating another workspace.
- Closed or merged PRs retire the ticket workspace using the existing conservative cleanup policy. Further implementation uses a new ticket.

Validation covers readable branch names, title stability, separate concurrent tickets, grouped clones and linked worktrees, unrelated repositories, branch collisions, replacement ownership after confirmed provider stop, persisted files, restart recovery and existing workflow/delivery behavior. Live Linear-to-T3Code acceptance remains a separate operator test.
