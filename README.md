# Linear T3Code Agent

A fork of [hiasinho/linear-pi-agent](https://github.com/hiasinho/linear-pi-agent), adapted to connect Linear Agent Sessions to an existing [T3Code](https://github.com/pingdotgg/t3code) environment.

Delegate a Linear issue to the app and select its prompt and expected output using YAML in its project description. Grilling, specification and ticket creation share a planning conversation and publish artifacts in Linear. Implementation starts a fresh conversation, tests the work and delivers a draft GitHub PR. Humans review each output and move the issue to request the next stage. The bridge never advances statuses, delegates children or merges PRs.

## What changed from linear-pi-agent

The original project connects Linear to the Pi coding agent. This fork retains its Linear OAuth installation, signed webhook intake and progress-formatting foundations, and replaces Pi execution with T3Code's authenticated orchestration API. Credit for the original integration goes to the [upstream project](https://github.com/hiasinho/linear-pi-agent).

| Area | This fork |
| --- | --- |
| Coding runtime | Your running T3Code environment and its configured providers/models |
| Repository selection | A project YAML entry matching an active T3Code project title |
| Session isolation | Preserved planning conversation; fresh implementation threads; shared session branch/workspace |
| Recovery | SQLite-backed queues, command identities, pending requests and event replay positions |
| Delivery | Linear planning artifacts; implementation draft PRs and validation reports |
| Pi configuration | No Pi executable or SDK required; `PI_*` settings are not used |

The bridge runs as a separate service and checkout from the application repositories it modifies. T3Code owns the coding execution; the bridge handles Linear communication, routing and delivery tracking.

```text
Linear issue / Agent Session
  → signed webhook → bridge and durable SQLite state
  → T3Code thread → selected workspace and task branch → draft GitHub PR
  → progress, questions and results back to Linear
```

When moving from linear-pi-agent, configure the T3Code connection and project YAML below. Existing Pi sessions are not migrated to T3Code; start new delegations after setup.

## Requirements

- Node.js **22.13 or newer**, npm, git and authenticated GitHub CLI (`gh`).
- A running T3Code environment with a working coding provider and model.
- Repository clones with a configured git identity and credentials that can push branches and create PRs.
- A Linear workspace admin to create and install the OAuth app.
- A public HTTPS address, through a reverse proxy or tunnel, forwarding to the bridge's localhost listener.
- The bridge and T3Code must see the same repository, worktree and context files at the same absolute paths. Running them on the same host is the simplest arrangement. A remote T3Code host needs shared files at identical paths; the bridge does not transfer checkouts.

## Quickstart: existing Linear and T3Code installations

Run the bridge on the **same host as T3Code**, under the account with access to your repositories and credentials. Both processes must see files at identical absolute paths. Setup does not provision infrastructure.

1. Clone and build the bridge separately from the repositories you want it to work on:

   ```sh
   git clone https://github.com/NorthStar-Technology-Advisory/linear-t3code-agent.git
   cd linear-t3code-agent
   npm ci
   npm run build
   ```

2. Keep T3Code running. Register your target repository as a project with a unique title and a working model/provider. On that host, obtain a credential:

   ```sh
   t3 auth session issue --label bridge --ttl 30d --token-only
   ```

   Paste the result only into setup's hidden credential prompt. Use the same T3Code data directory as the running instance (`--base-dir` if customized). This credential expires after 30 days; see [credential renewal](docs/operations.md#credentials-and-reconnection). The command grants administrative scopes in the verified T3Code version.

3. Arrange a stable public HTTPS address forwarding to `http://127.0.0.1:8787`. Follow the [persistent tunnel or reverse-proxy instructions](docs/operations.md#public-https). Then run:

   ```sh
   npm run setup
   ```

   Setup saves answers privately in `.env`, generates a missing installation secret, derives the callback/webhook URLs and provides a pre-filled Linear application link. Review that form in your workspace, fill in **your developer name**, review the website and agent settings, and paste the generated Client ID, Client secret and webhook signing secret when prompted. If you already created the app, use it; do not create another. Webhooks must include **Agent Session events and Issue updates**. No field unsupported by Linear's manifest is claimed to be pre-filled.

4. Add the YAML from [Project configuration](#project-configuration) as a code block in the Linear project's **detailed description**. Set `project` to the exact active T3Code project title, including case and spaces. Use the actual Linear team key and status names. When setup asks, supply an existing issue identifier from that project to check routing. Setup neither delegates it nor starts work. Model and workspace preferences come from T3Code; no UUIDs are needed.

5. Setup checks that the bridge and public HTTPS endpoint are reachable. If prompted, start the bridge in another terminal and press Enter in setup:

   ```sh
   npm run build
   npm start
   ```

   Setup opens Linear in your browser. Choose the intended workspace and approve the app. **The credentials identify your app; this one-time approval authorizes it to access the workspace.** Setup handles the installation secret internally—there is no extra secret to find or paste. It detects the saved installation automatically and runs diagnostics.

   If a browser cannot open, setup prints a direct Linear authorization link. Use `npm run setup -- --no-browser` to request that link explicitly. If the link expires or the browser reports an error, correct the problem and press Enter in setup to retry. Ctrl+C safely stops setup; rerunning preserves saved answers and completed installation.

   A completed run says **configuration and available connection checks passed**. Actual Linear webhook receipt, write permissions and end-to-end execution remain **unverified**. No coding task or draft PR is required to finish onboarding.

Use `npm run doctor` anytime for read-only diagnostics, or `npm run doctor -- --issue NOR-123` to inspect another project's association. Each check reports PASS, FAIL or UNVERIFIED and a repair step. Exit code 1 means setup is incomplete; 0 means available checks passed, with the displayed unverified checks still outstanding. Corrections use `npm run setup -- --replace KEY`; restart the bridge afterwards. If interrupted, just rerun setup. Keep `.env` private and never delete session or installation files to reconnect.

When ready for real work, configure the YAML and required skills below, then delegate an issue to the installed app. Keep the service running using [macOS/Linux operations](docs/operations.md#keep-the-bridge-running). Contributor checks and disposable delivery exercises live separately in [maintainer verification](docs/maintainer-verification.md).

## Project configuration

Add exactly one fenced YAML block with a top-level `t3code` key to the project's detailed description. The API field is `Project.content`, not the short summary (`Project.description`). Linear may return an unlabelled code fence; both forms work. Ordinary project prose and unrelated code blocks can surround it. Labels and status-description markers are no longer read.

[Complete four-stage example](docs/examples/project-config.yaml): replace the T3Code title, team key and status names with your actual values. Every configured status must exist, even if it is not currently selected. For a minimal implementation-only project:

```yaml
t3code:
  version: 1
  project: "My T3Code Project"
  instructions: |
    Preserve agreed decisions and explain blockers clearly.
  workflows:
    - team: "NOR"
      statuses:
        "Todo":
          new-thread: true
          output: draft-pr
          required-skills: [implement]
          prompt: |
            Use $implement to implement this issue.
            Read the linked context, test the changes and open a draft PR.
```

`version`, `project`, `workflows`, and each status's `prompt` and `output` are required. `instructions` is optional shared text. `required-skills` defaults to `[]`; `new-thread` defaults to `false`. These are strict schemas: unsupported keys, outputs and versions, duplicate YAML keys, repeated teams, multiple configuration blocks, aliases and malformed YAML pause execution. Team keys and status names match exactly, including case, and resolve to unique IDs. Teams must belong to the Linear project. Statuses omitted from the mapping are holding/review states.

| Output | Completion contract |
| --- | --- |
| `comment` | Publish the summary/decisions as a parent comment (current issue if it has no parent); no specification or children |
| `specification` | Publish a reviewable specification in the parent issue description |
| `tickets` | Publish an approved breakdown of native Linear children with acceptance criteria and blocking links |
| `draft-pr` | Report passing validation and verify an open draft GitHub PR |

Prompts select how work is performed; `output` selects what the bridge validates and publishes. Outputs do not implicitly invoke a particular skill. List any prerequisites in `required-skills` and invoke them in the prompt (for example, `Use $implement`). Install and maintain these skills in the selected provider's T3Code execution environment. Missing, disabled, non-user-invocable or ambiguous skills block execution. The bridge does not install skills, and required human reviews remain in effect. Repository/provider/model/workspace and service credentials are not configurable through prompts.

## Status-driven workflows

Both delegation to the installed app and a configured status are required. Initial delegation starts the selected stage. The bridge verifies the latest Linear Agent Session for the installed app using source creation times; delayed webhooks cannot take ownership back. A replacement waits for superseded providers to stop, and superseded sessions cannot resume. Subscribe the OAuth webhook to **Issue updates as well as Agent Session events**. Unrelated board movement cannot create a session.

On entering a configured status, the bridge snapshots its prompt, shared instructions, output and required skill paths. Follow-ups and restarts retain that snapshot and refresh Linear task context. YAML edits alone do not start work or alter an existing invocation; the next stage entry reads the latest configuration. Correct failed configuration and send `resume` to retry.

`new-thread: true` creates a fresh thread when entering that status, including re-entry, while preserving the session's branch, worktree, files, PR and artifact identities. Follow-ups stay in that thread. With `false` or omission, reuse the current thread, creating one if none exists. Returning to a planning status reuses the current conversation; there is no special restoration of a previous planning conversation. Separate delegations always have separate session threads. Long prompts and context are supplied through a complete-turn file when they exceed the transport limit; content is not truncated.

Humans move issues between stages. A stage change, move to an unconfigured status or removal of delegation stops execution first. Old questions, responses and queued prompts become inactive. The bridge confirms provider stop, then rechecks status/delegation so rapid moves cannot launch intermediate stages. A failed transition stop retains capacity and checkout ownership; repair T3Code and send `resume` to retry. Explicit `cancel` retires pending publication and queued work. Already accepted remote changes remain preserved. Current-checkout cancellation ends the session; worktree cancellation remains resumable. `resume` cannot bypass the status/delegation gate or reopen an ended session.

When upgrading from labels/markers, add project YAML and restart the bridge on the new build. Cancel old workflow sessions and start fresh delegations; legacy persisted stages cannot use the new configuration. Preserve the database and installation credentials.

### Artifacts and revisions

The parent description is the authoritative brief/specification. Parent comments retain grilling discussions and revision summaries. Children contain scope, acceptance criteria and a source-spec link; no duplicate full specification is needed. Planning requires no code changes, validation command, PR, repository Markdown, GitHub tickets or separate Linear document.

The installed skill returns structured publication content to the bridge after any required human review. The bridge publishes it with durable operation and child identities, verifies/reconciles writes, then reports completion. Child creation does not delegate work. Stable child keys are reused on re-entry and replacement delegation. After predecessor execution has stopped, the replacement inherits its child/dependency identity ledger before collecting context. Keys such as `constructor` and `__proto__` are treated as ordinary own keys. Unstarted children and their blocking links are reconciled; active, completed or delegated children retain their commitments and get proposed changes reported for human review. Omitted children are preserved and identified as possibly stale.

A rejected publication plan (for example, duplicate child keys) remains incomplete and accepts corrected feedback; planning completion is reported only after successful publication. Each accepted turn durably retains the child titles and descriptions supplied in its context. Child revisions are checked against that snapshot, including after restart, so human edits during generation are preserved. If the baseline is unavailable or a human changes an artifact during generation or publication, the bridge pauses rather than overwrite the change. Send revision feedback to start a refreshed turn in the current stage; the failed publication stays in history. Connection failures retry the retained operation after reading its remote identity/content, so a lost acknowledgement does not create a replacement artifact. Do not clear the database to repair publication. An interrupted publication may be partially applied; the next stage reads current artifacts and receives their retained identities.

Completing a stage never moves the board. Planning completion requires its actual Linear output; implementation still requires honest validation and a draft PR. See [NOR-197 acceptance](docs/acceptance/nor-197.md) for verified behavior and live acceptance prerequisites.

## Routing and permissions

The bridge matches the YAML `project` value exactly against active T3Code project titles. Deleted projects are excluded. Missing configuration, invalid team/status mappings, unknown titles and duplicate matching titles pause before execution. Duplicate-title errors list the matching workspace paths. Correct the YAML or T3Code configuration, then send `resume`. Duplicate webhook delivery and ordinary follow-ups do not retry failed initial resolution.

Provider/model choices come from T3Code's project overrides and environment defaults, with provider availability checked before work starts. A null snapshot override inherits the environment; a cleared effective model pauses until configured. The bridge does not choose a fallback model. Workspace precedence is the T3Code project setting, then repository `t3.json`, then the environment default. JSONC comments and trailing commas in `t3.json` are supported.

- **New worktree:** T3Code prepares the worktree using its supported turn bootstrap, locations, start-from-origin preference, and configured setup script. The repository default branch is selected, falling back to the checked-out branch when no default is known.
- **Current checkout:** the bridge reserves the canonical checkout path, then creates a task branch from current HEAD in that checkout. Existing files are preserved. Git failures pause with correction instructions. The reservation survives completed turns, idle periods, PR feedback, pauses and restarts. It covers bridge sessions; manual editor and shell activity remains outside it. If you change the checked-out branch manually, restore the session branch before resuming.

A competing current-checkout session pauses and identifies the occupying session. Once that session ends through PR closure/merge or confirmed cancellation, send `resume` to the waiting session. It never starts automatically when the checkout becomes free. Independent worktree sessions can run concurrently within `MAX_CONCURRENT_SESSIONS`.

The resolved project, workspace, model selection, workspace mode and branch/worktree identity persist for the session. Later project-title edits, renames and T3Code settings changes apply to new sessions. Status configuration is refreshed on each new stage entry. Issue text cannot select an arbitrary checkout. `PROJECT_ROUTES`, `T3CODE_PROVIDER` and `T3CODE_MODEL` are no longer used; this change has no legacy routing fallback or old-session migration.

Access to this agent in the configured Linear workspace authorizes coding and draft-PR work with **full execution permissions**. Run both services under a dedicated OS account containing only intended credentials and integrations. Worktrees isolate checkouts; routing and T3Code projects are **not filesystem sandboxes**. The operator provisions that account. Keep T3Code private and use a bearer credential permitting the required orchestration, settings/provider and VCS read operations. The installed T3Code version determines the exact scopes; settings RPC failures identify missing access.

## Conversations and recovery

Signed, fresh webhook intake is committed to SQLite before returning HTTP 200. Initial events deduplicate by workspace/session; follow-ups by Agent Activity ID. Queues, commands, activity outbox, routing, requests, PR state and replay positions survive restarts. Run **one bridge process per database**; a live-process ownership check prevents a second worker from executing the same queues.

The bridge reconciles T3Code snapshots and authenticated event catch-up. It retains exact command IDs across uncertain acknowledgements, using T3Code's durable command receipts. It never invents a new command ID to retry uncertain work. Linear activities have stable UUIDs and are looked up before retrying uncertain delivery. For a large replay gap, the bridge reconciles a fresh snapshot, including T3Code’s pinned pending requests, and reports that intermediate progress details are unavailable. Preserve the database and context directory when restarting or upgrading; do not delete state to repair a connection failure.

If a bootstrap connection fails after worktree preparation but before the first turn is confirmed, the bridge pauses without rerunning setup or starting coding. Inspect the setup in T3Code, complete or repair it, then send `resume`. The existing worktree and command identity are retained.

Responses remain pending until T3Code reports resolution. A provider response failure permits a corrected explicit reply. If event history is incomplete and a request is still pending, the bridge reports the prior response outcome as unknown; only a new explicit answer or approval retries it.

Ordinary follow-ups run in arrival order. A failed or incomplete turn pauses the queue; send `resume` to continue or `cancel` to clear it. Fix configuration/access first if that was the blocker. Paused active turns are still observed so completed remote work releases capacity, while their follow-up queue remains paused. A later prompt can resume a cancelled **worktree** session while its PR remains open. In **current-checkout** mode, cancellation ends the session permanently after the provider stops, releases its reservation even when no PR exists, and preserves files, branch and any PR. Further work requires a new delegation; `resume` cannot reopen that ended session. `MAX_CONCURRENT_SESSIONS` limits active sessions, including sessions waiting for an answer or for cancellation to finish.

Questions and approvals appear in Linear with request IDs:

```text
approve <request-id>
decline <request-id>
answer <request-id> {"question-id":"answer"}
```

Only explicit approval commands grant approval. Other messages stay queued. `stop`, `cancel`, and Linear's actual stop signal interrupt execution and stop the provider session, clear pending work, and preserve the thread, branch, worktree, edits and PR. New work waits until provider stop is observed. If T3Code reports a stop failure, repair the provider and send `cancel` to retry; the bridge retains the execution slot until stop is confirmed. Execution and human answers have **no bridge deadline**. Thirty-second network/git operation limits only bound individual connection attempts.

## Context and delivery

Before every turn, the bridge fetches the issue, its parent and children, all paginated text comments with authors/dates, attachment bodies, and directly related issues with their comments and attachments. Further relationships are recorded without recursively traversing the graph. Linear-hosted uploads are downloaded with OAuth into private context files. Downloads are limited to 50 MiB each; failures and limits appear in the inventory as unavailable. Credentials are never forwarded to external URLs or redirects.

External links are supplied to T3Code for retrieval through its authorized tools. They are explicitly marked unread by the bridge. Large context is supplied as a complete private JSON file rather than truncated. T3Code is instructed to read supplied files and maintain an inventory of read, summarized and unavailable sources. T3Code evaluates which specific sources are required using the issue and latest explicit clarifications. It must ask a question before implementation when required material is missing; if native questions are unavailable, it must report incomplete work and wait for clarification. Optional unavailable material does not automatically block an unrelated reading requirement.

For implementation, the agent returns a structured result with validation commands, outcomes, blockers and context access. The bridge checks for the session branch's draft PR through `gh`. Missing validation, failed/unavailable checks, blockers or a missing draft are reported as incomplete, with the PR link when available. Validation is identified as **reported by T3Code**. Same-session follow-ups update the existing PR. Once it closes or merges, further implementation requires a new delegation.

On PR closure or merge, active execution is stopped first. Current-checkout sessions release their reservation and preserve all checkout files and the task branch; worktree-removal cleanup never targets the current checkout. For worktree sessions, the bridge removes the worktree only when it is clean and its commits are reachable from freshly fetched origin refs. Dirty, untracked, unpushed, unverifiable and squash-merge cases are preserved conservatively and reported. Branches and session mappings remain. Ignored local files are checked explicitly and also preserve the worktree; git can otherwise delete them even without force.

## Operations

| Setting | Default |
| --- | --- |
| `BRIDGE_DB_PATH` | `./data/bridge.sqlite` |
| `WORKTREE_ROOT` (context/attachment storage; T3Code places worktrees) | `./data/worktrees` |
| `MAX_CONCURRENT_SESSIONS` | `1` |
| `POLL_INTERVAL_MS` | `1000` |
| `PR_POLL_INTERVAL_MS` | `60000` |
| `PROGRESS_DEBOUNCE_MS` | `3000` |
| `PROGRESS_HEARTBEAT_MS` | `300000` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` |

Expose `/linear/webhook`, `/linear/oauth/callback`, and the protected `/linear/install` route. `/healthz` is an optional liveness check, not evidence of external integration readiness. Keep `.env`, SQLite/WAL files, context files and token stores private. Shut down the bridge before a filesystem backup, or use a SQLite-consistent backup of the database plus its context files. SIGTERM preserves remote execution for restart recovery; it does not cancel coding work.

Run `npm test` for the integrated controlled-service suite, `npm run typecheck`, and `npm run build`. `npm run smoke:webhook` checks signed intake without creating a session; `npm run smoke:linear` checks the installed Linear identity without posting activities.

T3Code is not version-pinned. Settings, provider and branch reads use authenticated WebSocket RPCs. Bootstrap commands also use WebSocket RPC: the tested HTTP dispatch endpoint does not run bootstrap preparation. The adapter follows its authenticated [HTTP contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/environmentHttp.ts), [orchestration contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts), and [authentication model](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md). Contract/authentication failures are surfaced without response bodies or credentials. See [NOR-198 API validation](docs/acceptance/nor-198.md) for settings/worktree compatibility and [the original acceptance record](docs/acceptance/nor-173.md) for broader workflow evidence. Automated checks alone do not establish v1 readiness.
