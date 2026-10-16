# Webhook filter/forwarder replacement

Owner request: delete the bridge execution/orchestration functionality and turn the whole service into a filter/forwarder. This replaces the retired bridge specifications and operational behaviour. GitHub Issues are disabled for this repository; the direct user request and this spec are the implementation brief.

## Acceptance

- Remove every code path for T3 administrative/orchestration API calls, agent sessions, Linear API mutations, OAuth, publication, PR lifecycle and workspace/dependency cleanup.
- Reuse the installed service address and supervisor; receive Linear events without starting an agent for irrelevant events.
- Verify signatures and freshness, enforce organization/project/stage scope, and preserve active-to-inactive transitions for owner reconciliation.
- Forward original bytes to one configured native T3 webhook, with an optional distinct destination signature secret; no arbitrary event-supplied destination.
- Record successful receipts in a separate database and handle failures/concurrent retries without false success.
- Preserve the existing native dispatcher, its global ownership/capacity and holds, periodic reconciliation, pending input and PR watches.
- Preserve all historical on-disk credentials, sessions, worktrees and logs; deleting executable functionality does not authorise deleting operator data.
- Prove real HTTP forwarding/filtering, security boundaries, failure/restart behaviour and removal of legacy endpoints with local integration tests.
- Build output contains only the replacement; install/cutover requires tested new configuration and an inbound source signing secret that matches the actual Linear webhook.

## Deployment boundary

Prepare code, build and integration evidence before touching the installed service. Avoid any overlap with the retired bridge execution engine. The existing direct Linear→T3 path stays active until the receiver and its destination/signature configuration are ready; cut over the existing webhook rather than enabling a second execution system. No ordinary issue/comment should be used as a live forwarding probe that could dispatch work.
