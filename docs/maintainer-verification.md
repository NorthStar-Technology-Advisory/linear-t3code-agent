# Maintainer verification

This is separate from user onboarding. Start with the [quickstart](../README.md#quickstart-existing-linear-and-t3code-installations).

Run `npm run typecheck`, `npm test` and `npm run build`. The command tests use temporary configuration, repositories and fake services; the bridge integration tests exercise signed intake and recovery.

1. Exercise [NOR-197 live acceptance](acceptance/nor-197.md): delegate into grilling, answer in Linear, have a human advance to spec and tickets, then delegate a child for implementation. Verify thread continuity, published artifacts, an active transition and restart.
2. Delegate a disposable representative issue in a labelled project. Verify its thread and configured workspace mode, draft PR and validation report. Send a follow-up and verify the same PR updates. Restart the bridge during work and verify recovery. Stop an active session from Linear and verify edits survive and queued prompts are cleared. Exercise a question and an explicit approval. Record results using [acceptance/nor-173.md](acceptance/nor-173.md) and [NOR-198](acceptance/nor-198.md) before calling the deployment ready. Test current-checkout reservations through PR feedback and restart: competing sessions pause until explicit `resume` after release. Current-checkout cancellation ends the session after provider stop, preserves files/branch/PR, and requires a new delegation. Worktree cancellation remains resumable.


`npm run smoke:webhook` sends synthetic signed intake without creating a session. `npm run smoke:linear` reads the installation identity and may refresh OAuth credentials. Neither proves real webhook delivery. Record live acceptance separately; never require these exercises from a new user.
