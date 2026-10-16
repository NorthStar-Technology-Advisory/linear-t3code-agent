# Linear → T3 Code filter/forwarder

This service accepts signed Linear webhooks, drops routine events, and forwards relevant issue changes to an existing **native T3 Code webhook task**. It calls no model. T3 owns planning, dispatch, capacity, questions, implementation and PR lifecycle.

The former bridge execution engine has been deleted: no OAuth installation, Linear API client, agent/session runner, planning publication, GitHub integration, worktree manager, dependency sweep or recovery worker remains. The existing repository name, `/linear/webhook` address and service label are retained for installation continuity.

## Requirements and setup

- Node.js 24+, npm, and an existing T3 webhook task.
- A public HTTPS proxy to the listener (default `127.0.0.1:8787`). The existing Tailscale Funnel can be reused.
- Linear's source signing secret and the destination task's signing secret. They may be the same; set `T3_WEBHOOK_SECRET` only when different.

```sh
npm ci
cp .env.example .env
mkdir -p data
cp policy.example.json data/forwarder-policy.json
# Set private environment values and replace the example policy UUIDs.
npm run doctor
npm run typecheck
npm test
npm run build
npm start
```

`T3_WEBHOOK_URL` is the full token-bearing destination URL; treat it as a credential. Configuration fails closed when the destination or policy is missing/invalid. Existing unrelated `.env` entries are ignored. No OAuth or T3 administrative bearer is required. Keep configuration files private and outside Git.

`npm run doctor` only validates local configuration/policy; it performs no network call, refresh, installation or task launch. `GET /healthz` reports liveness. `/linear/install`, `/linear/oauth/callback`, and `/github/webhook` have been removed and return 404.

## Filtering policy

Set the organization, enabled projects, actionable state IDs and tracked state IDs in `FORWARDER_POLICY_PATH`. Use current UUIDs from Linear and the shared project registry; this file is an operational routing configuration, not another ownership database. Reload by restarting after policy changes. Every actionable state must also be tracked.

Typical actionable stages: Ready For Grilling, Ready For Spec, Ready For Tickets, Todo, Rework. Track those plus In Progress, Merging and Human Review. State names alone are never trusted or looked up from event text.

- **Forward:** creation directly into an actionable stage; entry/exit involving a tracked stage; project moves into/out of scope while tracked; changes to parent, labels, priority, assignee/delegate, archive or cancellation fields while tracked; removal of tracked issues.
- **Drop:** other organizations/projects, Comment and AgentSessionEvent resources, Backlog creation/edits, inactive-to-inactive transitions, description/title/workpad-only edits and updates that do not change routing fields.
- Moving an active issue back to Backlog or Canceled **is forwarded**, so the dispatcher can reconcile ownership/holds. A removal with missing state is conservatively forwarded if its project is in scope.
- Creation into an already-active stage does not adopt work. T3's scheduled reconciliation handles discovery and authoritative decisions.

The filter is deliberately stateless about issue ownership. It grants no permission to launch or resume work. Keep the existing twenty-minute reconciliation, native PR watches and native question handling. Dependency-only changes, changes not represented by Issue events and relevant edits filtered during a stage wait are recovered by reconciliation. Do not use ordinary Linear comments as the sole urgent stop/approval channel.

## Delivery and failure semantics

The receiver verifies HMAC-SHA256 against the **raw request body** and checks `webhookTimestamp` before classification. It forwards the exact bytes, preserving delivery/event/timestamp headers and signing those bytes with the destination secret. It never follows downstream redirects. It stores only payload digests and delivery receipts in a **new** `data/forwarder.sqlite`; no issue contents, tokens or legacy sessions are stored there.

A successful delivery is recorded and duplicate bodies are acknowledged without another downstream request, including after restart. Concurrent duplicate attempts receive a retryable 503 while the first is in flight. Failed/timeout deliveries return 503; Linear performs its own retries. In-process retries, queues, timers and autonomous workers are not used. A short receipt lease permits recovery after a crash.

Delivery is **at least once**, not exactly once: a crash after T3 accepts a request but before the receipt is committed can lead to a duplicate. Native T3 stage/owner deduplication remains essential. Very late source retries are rejected by the freshness window; periodic reconciliation is the recovery path. The configured forwarding timeout is at most four seconds, below Linear's five-second response deadline; the default is three seconds.

Structured audit logs contain only time, outcome and reason. They exclude payloads, destination URLs, signatures, upstream bodies and secrets. Dropped events cost no dispatcher/model turn. Distinct relevant events are not debounced; this version deduplicates identical deliveries only.

## Development and migration

```sh
npm run typecheck
npm test
npm run build
npm audit
```

The HTTP tests use real local receivers and a temporary SQLite database. They cover both directions of state changes, scope moves, ignored events, signatures, replay/freshness, body limits, raw-byte forwarding, different destination secrets, downstream errors/timeouts/redirects, concurrency and restart deduplication.

Follow [operations](docs/operations.md) for a staged cutover of the installed service. Preserve the old `data/bridge.sqlite`, OAuth token files, worktrees, logs and backups as historical data; the new service never opens or resumes them. Git history retains the deleted implementation and former specifications.
