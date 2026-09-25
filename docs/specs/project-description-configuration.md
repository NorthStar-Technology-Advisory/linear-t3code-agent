# Project description configuration

## Goal

Consolidate project labels and team status-description markers into one versioned YAML block in a Linear project's detailed description (`Project.content`). This supersedes the configuration selection in `t3code-project-routing.md` and the status-marker instructions in the README. No legacy label/marker fallback.

## Configuration

Require exactly one fenced block with a top-level `t3code` mapping. Accept YAML, yml and unlabelled fences, with ordinary prose and unrelated code blocks surrounding it. Version 1 requires an exact active T3Code project title and team-specific status mappings. Resolve exact team keys among the Linear project's teams and exact status names within each team to unique IDs. Reject missing/ambiguous names, duplicate keys/teams/blocks, unsupported fields/versions/outputs, malformed YAML and aliases before execution.

Each status requires a nonempty multiline-capable prompt and an output: `comment`, `specification`, `tickets`, `draft-pr` or `agent-managed`. `agent-managed` follows the status prompt for direct Linear publication and handoffs, without bridge artifact publication or a bridge-result block. `required-skills` defaults to an empty list and checks each named skill against the selected provider's workspace catalog. `new-thread` defaults to false. Optional project-wide `instructions` supplement each status prompt. Provider/model/workspace preferences continue to inherit from T3Code; service credentials, concurrency and polling remain instance settings.

## Execution

Delegation and a configured status are both required. Omitted statuses are holding states. On entry, snapshot the prompt, instructions, output and resolved skill paths durably. Follow-ups and restarts keep that snapshot; configuration edits alone do not trigger work. New invocations reread configuration. Session repository/model/workspace identity remains fixed once resolved. Invalid configuration pauses and needs correction followed by explicit resume.

Stop the prior provider before a status transition. `new-thread: true` starts a fresh conversation on each entry when a previous conversation exists; otherwise reuse the current conversation or create its first thread. Follow-ups do not create new threads. Returning to planning no longer restores a special saved planning thread. Preserve branch, worktree, files, PR and artifact identity across thread changes.

Output contracts preserve existing behavior: comment publishes the summary to the parent (or current issue without a parent); specification requires a revised parent description; tickets requires an approved child breakdown with acceptance criteria/dependencies; draft-pr requires passing reported validation and a verified open draft PR. The bridge continues to publish planning artifacts durably and protect human edits. No automatic status advancement, child delegation or PR merge.

Long prompts and context use the existing complete-turn file handoff when over the transport threshold, including all instructions without truncation. Setup/doctor must use the same YAML resolution path. Previously persisted legacy workflow stages require cancellation and fresh delegation; do not clear session storage.

## Validation

Test Markdown extraction, strict schema/defaults, multiline preservation, exact team/status resolution and pagination. At the bridge boundary verify configuration errors and resume, required skills, arbitrary prompts independent of output, all output contracts, snapshot persistence, thread transitions/re-entry/follow-ups, long prompt transport, and existing cancellation/recovery/publication invariants. Live end-to-end execution is performed by the operator after installing the new build and configuring actual statuses and skills.
