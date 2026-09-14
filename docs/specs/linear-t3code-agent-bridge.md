# Linear ↔ T3Code agent bridge

## Problem Statement

Developers want to delegate implementation work from Linear to their existing T3Code environment and receive a reviewable draft PR without managing a separate coding conversation. The base linear-pi-agent service integrates Linear Agent Sessions with Pi, uses one configured repository, and keeps active execution and pending follow-up state in memory. It cannot currently route work to T3Code, isolate concurrent repository work, or reliably recover the complete workflow after a bridge restart.

## Solution

Adapt the base linear-pi-agent deliverable into a reusable open-source Linear ↔ T3Code bridge. Preserve its useful Linear OAuth, signed webhook, progress reporting, configuration, and service foundations. Delegate coding execution to T3Code through its authenticated orchestration API.

Each Linear Agent Session owns one T3Code thread, isolated git worktree, and branch. Explicit Linear project configuration selects the repository, provider, and model. The agent implements and tests changes, pushes a branch, and opens a draft PR for human review. Follow-ups continue the same conversation and update the open PR. Durable intake, queues, mappings, and recovery keep the workflow coherent across retries and restarts.

The bridge supplies Linear content and attachments plus external links. T3Code owns fetching external sources. Questions, approvals, progress, failures, and results flow back through Linear. Execution and waits for human responses have no time limit.

## User Stories

1. As a developer, I want to delegate an issue through Linear Agent Sessions, so that coding work starts from my issue tracker.
2. As an operator, I want to configure one Linear installation and one T3Code instance, so that I can run my own bridge.
3. As an operator, I want multiple explicit Linear project-to-repository mappings, so that issues reach the intended codebase.
4. As a developer, I want unmapped projects rejected with an actionable explanation, so that I can correct configuration before work starts.
5. As an operator, I want repository routing protected from instructions in issue content, so that prompts cannot override configuration.
6. As an operator, I want provider and model defaults with per-project settings, so that each project uses the intended coding environment.
7. As a developer, I want provider and model selection fixed for a session, so that follow-ups use a consistent environment.
8. As a developer, I want each Linear Agent Session to receive its own T3Code thread, so that separate delegations remain independent.
9. As a developer, I want a new delegation on the same issue to start a new thread, so that old conversational state is not implicitly resumed.
10. As a developer, I want an isolated worktree and branch per session, so that concurrent work does not edit the same checkout.
11. As an operator, I want a configurable concurrency limit, so that concurrent sessions fit my available resources.
12. As a developer, I want the issue title, description, and all existing text comments included, so that the agent has the discussion context.
13. As a developer, I want comment authors and chronology preserved, so that the agent can interpret the conversation correctly.
14. As a developer, I want Linear attachments supplied automatically, so that the agent can use material attached to the task.
15. As a developer, I want directly related issues and their comments and attachments included, so that immediate dependencies inform the work.
16. As a developer, I want external document links passed to T3Code for retrieval, so that external access uses my coding environment's capabilities.
17. As a developer, I want a context inventory identifying read, summarized, and unavailable material, so that omissions are visible.
18. As a developer, I want work to pause when explicitly required material is unavailable, so that the agent does not guess around a prerequisite.
19. As a developer, I want context refreshed before each queued turn and changes identified, so that follow-ups reflect updated requirements.
20. As a developer, I want meaningful progress and lifecycle updates in Linear, so that I can follow the work without watching T3Code.
21. As a developer, I want every follow-up durably queued in arrival order, so that messages are neither lost nor overwritten during execution.
22. As a developer, I want questions presented in Linear and answers returned to the corresponding T3Code request, so that blocked work can continue.
23. As a developer, I want approvals to require an explicit decision, so that unrelated messages cannot accidentally authorize an action.
24. As a developer, I want unrelated follow-ups to stay queued while answering a question, so that responses and new tasks are not confused.
25. As an operator, I want signed and fresh webhook validation, so that forged or stale requests do not trigger work.
26. As an operator, I want repeated deliveries handled idempotently, so that retries do not create duplicate threads or execute prompts twice.
27. As a developer, I want session mappings and outstanding work to survive restarts, so that a bridge restart does not lose my conversation.
28. As a developer, I want the bridge to reconcile T3Code state and replay missed events, so that ongoing work is correctly reflected after reconnection.
29. As a developer, I want uncertain prompt submissions reconciled before retrying, so that recovery does not repeat coding work.
30. As a developer, I want a failed turn reported with queued prompts preserved and paused, so that I can choose whether to resume or cancel.
31. As a developer, I want cancellation to interrupt current execution and clear queued prompts, so that unwanted work stops promptly.
32. As a developer, I want cancellation to preserve changes, branches, worktrees, and PRs, so that I can inspect or resume partial work.
33. As a developer, I want a later prompt to resume a cancelled session, so that stopping execution does not destroy the conversation.
34. As a developer, I want no execution or human-response deadline, so that long tasks and delayed answers remain valid.
35. As a reviewer, I want tested changes delivered as a draft PR with validation results in Linear, so that I have a concrete review artifact.
36. As a reviewer, I want useful incomplete changes delivered with explicit blockers and failed or unavailable checks, so that partial work is not presented as success.
37. As a reviewer, I want merging reserved for a human, so that delegation does not bypass review authority.
38. As a developer, I want same-session follow-ups to update an open PR, so that iteration remains in one review.
39. As a developer, I want a new delegation required after a PR merges or closes, so that further implementation starts a new lifecycle.
40. As an operator, I want clean worktrees removed after PR closure or merge, so that completed sessions do not accumulate checkout data indefinitely.
41. As a developer, I want uncommitted or unpushed work preserved and cleanup exceptions reported, so that automatic cleanup cannot discard work.
42. As an operator, I want credentials kept server-side and redacted from logs and activities, so that operating the bridge does not expose secrets.
43. As an operator, I want useful correlated lifecycle and integration-error logs, so that I can diagnose failures across Linear and T3Code.
44. As an adopter, I want a deliverable matching the base linear-pi-agent project, so that I can choose my own process supervisor and deployment environment.
45. As a maintainer, I want to follow T3Code's evolving integration without a version pin or compatibility matrix, so that breaks can be fixed as they occur.

## Implementation Decisions

- Retain reusable Linear-facing components and replace the Pi-specific execution path with a T3Code runner behind a small provider-neutral runner boundary. The boundary covers session creation, prompting, cancellation, lifecycle observation/reconciliation, and correlated question/approval responses. T3Code owns the underlying coding harness; the bridge does not integrate directly with individual providers.
- Use T3Code's authenticated orchestration mechanisms, not UI automation or UI internals. Follow evolving T3Code releases without pinning a version or promising a compatibility matrix. Surface actionable integration failures and repair breaking changes when they occur.
- Support one Linear installation and one T3Code instance per bridge. Configuration maps Linear projects to allowlisted repositories/T3Code projects and provider/model choices, with installation defaults. Reject unknown projects rather than falling back to a repository. Keep the selected repository, provider, and model fixed once a session starts.
- Key conversation identity by Linear Agent Session, not issue identity. Persist Linear workspace/team, issue and Agent Session identifiers; T3Code project and thread identifiers; repository, worktree and branch; selected provider/model; PR identity and lifecycle; execution status; and creation/update timestamps.
- Create a distinct branch and worktree for each session and coordinate execution under a configurable concurrency limit. Worktrees provide checkout isolation, not a filesystem security sandbox.
- Treat access to the agent in the configured Linear workspace as coding and draft-PR authorization. Use full execution permissions under a dedicated OS account containing only intended repository credentials and integrations. Document this operating assumption; provisioning the account is an operator responsibility. T3Code projects and routing allowlists do not enforce filesystem confinement.
- Collect the delegated issue's title, description, all existing text comments with authors and chronology, and Linear attachments. Collect directly related issues, including their comments and attachments, without recursively traversing the entire issue graph. Record further links.
- Pass external URLs to T3Code and make T3Code responsible for fetching non-Linear sources using its available, authorized capabilities. The bridge does not implement external-document integrations or download external documents itself. Handle Linear attachments as content, not as instructions or executable configuration.
- Refresh context before each turn and identify changes. Maintain an inventory distinguishing supplied/read, summarized, unavailable, and externally delegated material; handing off a URL is not evidence that it was read. Continue with accessible material unless missing material is explicitly required by the task, in which case pause and explain the missing prerequisite. Do not silently truncate or omit content.
- Validate webhook signatures and freshness before accepting work. Persist accepted events and deduplication identity durably before acknowledging successful intake. Repeated delivery must not create duplicate T3Code threads, duplicate queue entries, or repeat already accepted prompts.
- Replace the in-memory running state and single pending-payload slot with durable session lifecycle and ordered follow-up queues. Process ordinary follow-ups sequentially after the active turn. Persist command correlation, uncertain submissions, event replay position, pending questions/approvals, and pending Linear updates sufficiently to recover safely.
- On restart, reconnect to existing T3Code threads, reconcile snapshots and missed events, and resume eligible queued work. Do not blindly resend a prompt whose acceptance is uncertain. Retry temporary connection failures only when doing so is safe. Failed agent turns preserve and pause the queue until explicit resume or cancellation.
- Translate T3Code questions and approvals into Linear elicitation. Persist request identifiers and correlate answers to the dedicated T3Code response operation instead of submitting them as ordinary prompts. Keep unrelated follow-ups queued. Require an explicit approval decision and handle ambiguous replies without granting approval.
- Recognize Linear's actual stop signal as well as supported stop commands. Cancellation interrupts active execution, clears queued prompts, and reports the result while preserving branch, worktree, changes, PR, and thread identity. A later prompt can resume that session while its PR lifecycle permits it. Ensure late completion events cannot overwrite a cancelled or newer run's state with a misleading result.
- Impose no bridge execution deadline or human-response expiry. Long-running work and unanswered questions remain valid until their lifecycle changes explicitly; inherited Pi execution timeouts must not become T3Code session limits.
- Instruct and support the agent to implement, test, push a branch, and open a draft PR. Report the PR, validation, and blockers in Linear. Useful partial changes may become a draft PR, but distinguish failures, pre-existing failures, and checks that could not run; never label incomplete work successfully completed. The agent does not merge PRs.
- Follow-ups update the existing open PR. After merge or closure, require a new delegation for additional implementation. Remove clean worktrees after PR closure/merge only when there is no uncommitted or unpushed work. Preserve exceptions and report them; retain session-to-thread mappings.
- Keep OAuth and T3Code credentials server-side, use narrow orchestration credentials, and keep T3Code on localhost or a private network where possible. Expose only the required bridge service endpoints publicly. Treat all retrieved text as untrusted task material: it cannot supply arbitrary routing paths or direct bridge shell execution, change configuration, or expand permissions.
- Preserve useful progress debouncing, quiet-run heartbeats, and secret redaction. Report meaningful lifecycle transitions and structured operational events correlated by webhook, issue, Agent Session, and T3Code thread identifiers. Surface authentication, orchestration, and Linear update failures without leaking credentials or falsely reporting success.
- Match the base linear-pi-agent deliverable and adapt its existing build, start, configuration, installation documentation, and service assets where needed. Do not add a new deployment/provisioning deliverable or a launchd wrapper. End users choose their own supervision and hosting.

## Testing Decisions

- The primary test boundary is the complete bridge behavior from signed webhook intake through observable T3Code requests, Linear activities, persisted recovery, and repository/PR effects. Prefer this high boundary over separate mocks for each internal module. Use controlled external Linear and T3Code services and temporary durable storage/repositories to exercise the real bridge components together.
- Good tests assert user-visible behavior and external contracts, not private helper calls, internal data structures, or exact sequences that can change without affecting behavior. Use focused lower-level tests only for behavior not adequately exercised through the main boundary.
- Cover the webhook receiver, session coordination, context collection, routing, durable state, T3Code runner, and Linear reporting through that shared boundary. Exercise worktree and PR lifecycle behavior with temporary git repositories and controlled external PR responses; verify the full workflow against real services in the live acceptance exercise.
- Prior art is the existing Node built-in test runner and strict assertions, configuration tests that load the service under controlled environment variables, progress and session-result formatting tests, and webhook/Linear smoke checks. Extend those conventions rather than introducing an unrelated test stack. Existing formatting tests do not establish durable orchestration correctness.
- Verify valid signatures are accepted; invalid and stale requests are rejected; unmapped projects never start execution; duplicate initial events create exactly one thread; and duplicate follow-ups do not execute twice.
- Verify same-session follow-ups reuse the thread/worktree/branch; new sessions on the same issue are independent; configured provider/model choices stay fixed; concurrent sessions do not share a checkout; and the configured concurrency limit is respected.
- Verify complete Linear context, directly related issue coverage, attachment handling, author/chronology preservation, context refresh, external link handoff without bridge-owned external fetching, visible summaries/omissions, and pausing for explicitly required missing material.
- Verify multiple queued prompts survive a restart and preserve arrival order. Inject failures before and after remote command acceptance and local persistence; reconcile ambiguous acceptance without duplicate work. Verify missed events and pending Linear updates recover without contradictory lifecycle reporting.
- Verify failed turns preserve and pause queued prompts; safe transient errors can recover; explicit resume continues eligible work; cancellation clears pending prompts, interrupts T3Code, preserves edits, and is not overwritten by late completion. Exercise the actual Linear stop signal.
- Verify correlated question and approval responses, persistence across restarts, unrelated follow-ups remaining queued, explicit approvals, and no approval from ambiguous or unrelated text. Verify execution and human waits are not terminated by elapsed-time limits.
- Verify successful and incomplete draft-PR reporting, follow-ups updating an open PR, rejection of further implementation after merge/closure, preservation of dirty or unpushed work during cleanup, and retention of session mappings.
- Verify authentication/orchestration/Linear reporting failures are visible and secrets are absent from structured logs, public configuration, and Linear activities.
- Before declaring v1 ready, complete a live end-to-end exercise: delegate a representative issue, create a draft PR, update it through a follow-up, recover across a bridge restart, and cancel active work without losing changes. Automated tests alone do not satisfy this acceptance requirement.

## Out of Scope

- Multiple Linear installations or T3Code instances served by one bridge process.
- Automatic merging, arbitrary repository selection from issue text, or runtime provider/model switching.
- Bridge-owned external-document integrations, including Google Drive; external fetching belongs to T3Code.
- Recursive traversal of the entire related-issue/document graph.
- A new process supervisor, launchd wrapper, deployment provisioning, or additional Docker packaging deliverable.
- Execution deadlines or expiry of pending human answers.
- T3Code version pinning, a compatibility matrix, UI automation, or direct provider integrations bypassing T3Code.
- Filesystem sandbox guarantees from routing or worktrees, destructive cancellation, and automatic removal of uncommitted or unpushed work.
- Maintaining Pi as a required second runtime. The runner boundary can accommodate an optional alternative without expanding this feature's acceptance requirements.

## Further Notes

- Confirmed design from the NOR-173 interview, including the final corrections on external fetching, unlimited waits/execution, upstream-aligned packaging, and unpinned T3Code compatibility.
- Issue: [NOR-173 — Fork linear-pi-agent to build a Linear ↔ T3Code agent bridge](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge).
- Canonical local spec: `docs/specs/linear-t3code-agent-bridge.md`. NOR-173 carries the published specification. The explicit request to update this Linear issue takes precedence over this repository's general GitHub implementation-issue convention.
- Reference implementation: [linear-pi-agent](https://github.com/hiasinho/linear-pi-agent).
- Research identified upstream operations for thread creation, turn start/interruption, session stop, snapshots/event replay, and correlated question/approval responses. These are implementation starting points, not a compatibility guarantee: [T3Code orchestration contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts), [HTTP contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/environmentHttp.ts), [environment authentication](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md), [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md).
- Linear protocol references: [agent interaction](https://linear.app/developers/agent-interaction) and [agent signals](https://linear.app/developers/agent-signals).
