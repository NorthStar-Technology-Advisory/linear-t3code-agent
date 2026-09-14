# Route Linear projects by T3Code title and inherit execution settings

Issue: [NOR-198](https://linear.app/northstar-tech-advisory/issue/NOR-198)
Status: Agreed specification, 2026-09-14.

## Problem Statement

Connecting a Linear project currently requires maintaining PROJECT_ROUTES with Linear and T3Code UUIDs, repository paths, and execution defaults. Users want to select a recognizable project title in Linear and manage execution settings in T3Code.

This bridge is not live and has no existing sessions. Compatibility and migration are unnecessary.

## Solution

Apply one label from the Linear project label group **T3Code project**. Its plain-text name must exactly match one active T3Code project title. The bridge resolves the project and inherits its effective provider/model and workspace settings.

Honor both T3Code workspace modes. New-worktree sessions use T3Code's normal worktree behavior. Current-checkout sessions create a task branch in that checkout and reserve it for the session. Errors explain what to correct; the user deliberately retries with `resume`.

## User Stories

1. As a user, I want to select a T3Code project by title in Linear, so that I do not need to discover UUIDs.
2. As a user, I want new Linear projects to work through labels alone, so that I do not maintain per-project bridge configuration.
3. As a user, I want exact, case-sensitive title matching, so that the bridge cannot guess the wrong project.
4. As a user, I want deleted projects excluded, so that work only targets active projects.
5. As a user, I want missing or ambiguous labels explained before work starts, so that I can correct the selection.
6. As a user, I want unknown titles identified, so that I can fix a label or renamed project.
7. As a user, I want duplicate-title errors to list matching workspace paths, so that I can distinguish and rename the projects.
8. As a user, I want to retry corrected configuration with resume, so that recovery is deliberate.
9. As a user, I want provider/model overrides and inherited defaults resolved from T3Code, so that I maintain settings in one place.
10. As a user, I want missing effective model settings to pause work, so that the bridge does not silently choose a model.
11. As a user, I want the bridge to honor my T3Code workspace setting, so that I control whether work uses my checkout or a new worktree.
12. As a user, I want new worktrees to follow T3Code's starting-branch behavior, so that I do not configure another base branch.
13. As a user, I want current-checkout tasks to receive their own branch from current HEAD, so that the task can produce a draft PR.
14. As a user, I want a current checkout reserved through PR feedback, so that another bridge session cannot change it between turns.
15. As a user, I want a competing session paused with a clear explanation, so that I can resume it after the checkout is released.
16. As a user, I want independent worktree sessions to run concurrently within the bridge's concurrency limit, so that unrelated work can progress.
17. As a user, I want cancellation to stop and end a current-checkout session without deleting its files, so that I can abandon a task and reclaim the checkout.
18. As a user, I want established sessions to retain their project and settings after renames or configuration changes, so that follow-ups stay with the original task.
19. As a user, I want restarts and duplicate webhooks to preserve session identity and checkout reservations, so that recovery cannot duplicate or redirect work.
20. As a user, I want setup documentation covering labels, settings, concurrency, cancellation, and retries, so that I can operate the bridge without learning its internals.

## Implementation Decisions

- Replace PROJECT_ROUTES. Remove the requirement for bridge-owned provider/model and per-project base-branch defaults; retain instance connection and authentication configuration. No compatibility fallback or old-session migration.
- Extend the existing Linear client to read project labels and identify the group named **T3Code project**. Require one unambiguous group and exactly one selected child label. Missing projects, groups, selections, or multiple selections produce actionable Linear errors before execution.
- Extend the existing runner adapter to read active project identity, title, workspace, and effective settings through supported T3Code APIs. Match titles exactly and case-sensitively, excluding deleted projects. Duplicate matches must identify their workspace paths.
- Resolve project overrides and environment defaults using T3Code's settings semantics, including provider availability validation. Nullable project overrides are not effective defaults. If a valid effective provider/model cannot be resolved, pause with instructions to configure T3Code and send resume; do not invent a bridge fallback.
- Honor T3Code's effective workspace setting, including repository configuration in the inheritance chain. Resolve and durably retain the project ID, workspace, provider/model, workspace mode, and session branch/worktree identity once valid session configuration is established.
- For new worktrees, use the supported T3Code turn bootstrap/worktree preparation flow. Select the repository default branch, falling back to the checked-out branch when no default is known, and inherit T3Code's start-from-origin setting. Follow normal T3Code setup behavior.
- For current checkout, create a session task branch from current HEAD in the same checkout. Do not create a worktree for this mode. Preserve existing files and surface Git failures without destructive cleanup.
- Use the existing durable session store to enforce one current-checkout session per canonical checkout path. Reserve before checkout mutation or execution; ensure competing sessions cannot both claim it. No new queue or coordination service.
- Keep the reservation across completed turns, idle periods, PR feedback, pauses, and restarts. A merged or closed PR ends the session and releases the reservation after any active execution has stopped. Never run worktree-removal cleanup against the user's current checkout.
- A competing session pauses with an explanation identifying the occupying session. It does not automatically start when the reservation becomes free; the user sends resume.
- In current-checkout mode, cancel ends the session and releases its reservation only after the agent has stopped, including when no PR exists. Preserve files, branch, and any PR. Further work requires a new delegation; resume cannot reopen that ended session.
- Keep worktree sessions independent, subject to existing global concurrency limits. This feature's checkout reservation applies to bridge sessions, not arbitrary editor or shell activity.
- Preserve established session identity across follow-ups and recovery. Later title, label, or settings changes apply to new sessions. Failed initial resolution remains retryable after correction; duplicate webhook delivery is not a retry.
- Update setup and operating documentation to describe the final behavior, replacing UUID-based routing instructions and the previous unconditional-isolation requirement.

## Testing Decisions

Prefer the existing bridge integration seam: signed webhook input, fake Linear and T3Code services, real temporary Git repositories, and the real SQLite session store. Extend that harness rather than adding a new test abstraction. Prior art includes delegation, restart recovery, duplicate-delivery, cancellation, and PR lifecycle tests in the existing bridge suite.

Good tests assert observable behavior: which project and model receive work, what Git checkout/branch exists, which Linear error is reported, whether work starts once, and when a competing session can proceed. Do not assert private helper structure.

Cover:

- Exact active-project success; missing group or label; multiple selected labels; unknown, case-mismatched, deleted, and duplicate titles, including duplicate workspace paths and correction followed by resume.
- Project overrides, inherited model defaults, null overrides, unavailable or missing effective models, and effective workspace precedence.
- Worktree default-branch selection and checked-out-branch fallback, start-from-origin behavior, and current-checkout branching from HEAD without creating another worktree.
- Competing sessions targeting the same canonical checkout, retention through idle/feedback/restart, and explicit resume after PR closure or cancellation releases it.
- Cancellation before PR creation, delayed provider stop, terminal cancellation, and preservation of current-checkout files.
- Renames and settings changes after session establishment, new-session resolution of updated settings, duplicate deliveries, and restart recovery without duplicate branches or work.

Update the existing configuration tests to prove startup no longer requires PROJECT_ROUTES or bridge provider/model defaults while preserving connection validation and secret redaction.

Verify the supported settings and worktree contracts against the configured T3Code version during implementation; fake-service tests alone do not establish live API compatibility.

## Out of Scope

- Migration, legacy routing fallback, or preserving the old unconditional-isolation behavior.
- Fuzzy matching, automatic project renaming, or separate provider/model/base-branch label groups.
- Automatic retry or checkout wait queues.
- Cross-process/distributed locking infrastructure or coordination with manual editor and shell activity.
- Destructive cleanup of current-checkout files or automatic rollback on cancellation.
- Unrelated changes to worktree cancellation, deployment, or execution permissions.

## Further Notes

The agreed current-checkout behavior explicitly supersedes the original issue's unconditional worktree-isolation requirement.

Upstream source investigation found supported settings RPCs and turn bootstrap. It also confirmed that an orchestration snapshot's null project defaults cannot be treated as resolved settings. These findings guide implementation; validation against the configured instance remains required.

Primary references:

- [T3Code RPC contracts](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/rpc.ts)
- [Project settings resolution](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/projectSettings.ts)
- [Workspace-mode inheritance](https://github.com/pingdotgg/t3code/blob/main/packages/shared/src/threadEnvMode.ts)
- [Turn bootstrap contracts](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts)
- [Normal worktree starting-branch selection](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/BranchToolbarBranchSelector.tsx#L505-L538)

