# Changelog

## NOR-197 — artifact review fixes

- Carry child and dependency identities into replacement sessions after provider stop.
- Check child revisions against the context captured before the agent turn, preserving intervening human edits across restart.
- Allocate ticket identities using own-property checks, including keys such as `constructor` and `__proto__`.

## NOR-197 — review fixes

- Resolve the current issue session from Linear's session chronology, stop superseded providers before replacement work, and reject stale session follow-ups.
- Retire publication on explicit cancellation and guard writes after asynchronous preflight reads.
- Keep rejected publication preparation incomplete and allow corrected feedback without a false completion response.

## NOR-197 — status-driven workflows

- Select grilling, specification, tickets or implementation through team status-description markers and explicit delegation.
- Preserve planning context, start fresh implementation conversations, stop superseded stages and retain workspace/PR state.
- Publish and reconcile native Linear artifacts with durable identities; retain Q&A and revision summaries in parent comments.
- Verify installed workspace skills, refresh parent/child context and distinguish planning completion from implementation delivery.
- Document operator setup, human progression and recovery; see the NOR-197 acceptance record for live coverage limits.

## Unreleased

### NOR-173: Linear ↔ T3Code bridge

- Replace the Pi runtime with authenticated T3Code orchestration and explicit project routing.
- Add isolated worktrees, durable webhook intake and queues, command/outbox reconciliation, event replay, correlated questions and approvals, and cancellation without discarding work.
- Refresh complete Linear context and delegate external retrieval to T3Code; report source availability and preserve oversized input in private files.
- Verify draft-PR delivery and validation reports, enforce closed-PR lifecycle rules, and clean only verified clean/pushed worktrees.
- Adapt configuration, installation and service assets; require Node.js 22.13 or newer. Live acceptance remains outstanding in `docs/acceptance/nor-173.md`.

### Earlier upstream Pi changes

Changes since `v0.1.0`.

### Added

- Linear progress updates for Pi SDK session events, including session start, thinking, tool execution, context compaction, retries, and tool errors.
- A start activity when the service receives a Linear agent session and begins work.
- `POSSIBLE_IMPROVEMENTS.md` with prioritized follow-up ideas for progress reporting and operational polish.
- Recommended hosting guidance and a short roadmap in the README.
- Configurable Pi progress heartbeats through `PI_PROGRESS_HEARTBEAT_MS`.
- Unit tests for progress deduplication, event mapping, sanitization, and heartbeat behavior.
- Config tests for Pi theme defaults, custom theme names, and safe public runtime config.
- Report completion progress for successful long-running tools using toolCallId-based tracking.

### Changed

- Initialize the Pi SDK theme for non-interactive runs so installed extensions with background widgets do not crash the service.
- Improve tool argument summaries by recognizing `cmd` as well as `command`.
- Upgrade `@earendil-works/pi-coding-agent` to `^0.80.3` and add `undici`.
- Upgrade dependency ranges for `express` to `^4.22.2` and `tsx` to `^4.23.0`.
- Deduplicate pending and already-sent Linear progress updates, stop generic `turn_start` progress spam, sanitize tool progress, and flush pending progress before Pi error or timeout results.
- Centralize Pi theme configuration through validated `PI_THEME`.
- Improve Linear tool progress summaries with tool-aware, redacted, truncation-safe formatting.

### Security

- Add optional `INSTALL_SECRET` protection for `/linear/install`, accepted through `?install_secret=` or a Bearer token.
- Document public endpoint protections, Linear webhook signature expectations, and deployment security considerations.
- Update transitive dependencies to clear the `qs`/`express` and `esbuild` npm audit findings.

## 0.1.0 - 2026-05-12

Initial public release of Linear Pi Agent.

### Added

- Linear OAuth install flow, webhook endpoint, and agent session handling.
- Pi SDK session execution against a configured repository.
- Local persistence for Linear tokens, OAuth state, and Pi session data.
- Follow-up prompt handling for existing Linear agent sessions.
- Setup, deployment, and systemd documentation.
