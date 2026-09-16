# Linear T3Code Agent

A fork of [hiasinho/linear-pi-agent](https://github.com/hiasinho/linear-pi-agent), adapted to connect Linear Agent Sessions to an existing [T3Code](https://github.com/pingdotgg/t3code) environment.

Delegate a Linear issue to the app and select its workflow using a marker in its team status description. Grilling, specification and ticket creation share a planning conversation and publish artifacts in Linear. Implementation starts a fresh conversation, tests the work and delivers a draft GitHub PR. Humans review each output and move the issue to request the next stage. The bridge never advances statuses, delegates children or merges PRs.

## What changed from linear-pi-agent

The original project connects Linear to the Pi coding agent. This fork retains its Linear OAuth installation, signed webhook intake and progress-formatting foundations, and replaces Pi execution with T3Code's authenticated orchestration API. Credit for the original integration goes to the [upstream project](https://github.com/hiasinho/linear-pi-agent).

| Area | This fork |
| --- | --- |
| Coding runtime | Your running T3Code environment and its configured providers/models |
| Repository selection | A Linear project label matching an active T3Code project title |
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

When moving from linear-pi-agent, configure the T3Code connection and project labels below. Existing Pi sessions are not migrated to T3Code; start new delegations after setup.

## Requirements

- Node.js **22.13 or newer**, npm, git and authenticated GitHub CLI (`gh`).
- A running T3Code environment with a working coding provider and model.
- Repository clones with a configured git identity and credentials that can push branches and create PRs.
- A Linear workspace admin to create and install the OAuth app.
- A public HTTPS address, through a reverse proxy or tunnel, forwarding to the bridge's localhost listener.
- The bridge and T3Code must see the same repository, worktree and context files at the same absolute paths. Running them on the same host is the simplest arrangement. A remote T3Code host needs shared files at identical paths; the bridge does not transfer checkouts.

The core live acceptance exercise passed against a Mac Mini T3Code environment: draft-PR delivery, same-session follow-up, restart recovery and cancellation with preserved edits. See [the acceptance record](docs/acceptance/nor-173.md) for evidence, tested configuration, an observed orphaned-child-process limitation during cancellation, and remaining live coverage limits. Verify your own deployment using the checklist below.

## Setup

The steps below cover a fresh installation. [INSTALL.md](INSTALL.md) also provides a compact deployment checklist suitable for a coding agent.

### 1. Prepare the bridge and T3Code

Clone this fork separately from your target repositories, then run:

```sh
git clone https://github.com/NorthStar-Technology-Advisory/linear-t3code-agent.git
cd linear-t3code-agent
npm ci
cp .env.example .env
chmod 600 .env
```

In T3Code, register each target repository as a project with a unique, recognizable title. Configure its model and workspace preferences there, or let them inherit environment defaults. Obtain a bearer credential permitting orchestration reads/commands, settings and provider reads, and VCS branch/status reads using T3Code's current [environment authentication flow](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md).

Set these values in `.env`:

```dotenv
T3CODE_URL=http://127.0.0.1:3773
T3CODE_TOKEN=your-private-t3code-bearer-token

```

In Linear **Settings → Projects → Labels**, create exactly one project label group named **T3Code project**. Add a child label whose plain-text name exactly matches the T3Code project title, including case and spaces, and select it on the Linear project containing your issue. For example, T3Code project **Payments API** uses child label **Payments API**. Apply the label to the project, not the issue. New Linear projects need only this label; no UUID mapping is required. See [Linear project labels](https://linear.app/docs/project-labels) and [routing and permissions](#routing-and-permissions).

### 2. Choose the public bridge address

Configure your HTTPS proxy or tunnel to forward to `http://127.0.0.1:8787`. Use your own address wherever `https://your-domain.example` appears below:

```dotenv
BASE_URL=https://your-domain.example
LINEAR_REDIRECT_URI=https://your-domain.example/linear/oauth/callback
```

Expose `/linear/webhook`, `/linear/oauth/callback` and the protected `/linear/install` route. `/healthz` is optional. Keep the T3Code endpoint private. If your tunnel address changes, update `.env` and the Linear app's redirect and webhook URLs together, then restart the bridge.

### 3. Create the Linear OAuth app

Sign in as a workspace admin and open [Linear's new application form](https://linear.app/settings/api/applications/new), also available through **Settings → API**. Follow Linear's [agent setup documentation](https://linear.app/developers/agents) if the settings labels change.

1. Select the intended workspace and create an OAuth application. Choose a recognizable name, such as **T3Code Agent**; this is how users will identify it in Linear. For an internal deployment, keep its distribution private if offered.
2. Fill in the application's description and developer details. Use your own application or repository URL for any required website field.
3. Set the redirect URI to `https://your-domain.example/linear/oauth/callback`. It must exactly match `LINEAR_REDIRECT_URI`.
4. Save the app. Copy its **Client ID** and **Client secret** into `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` in your private `.env` file.
5. In the app's webhook settings, enable webhooks and set the URL to `https://your-domain.example/linear/webhook`.
6. Select **Agent session events** in the webhook resource list and save. Copy the **webhook signing secret** into `LINEAR_WEBHOOK_SECRET`.

Use the normal authorization-code OAuth flow. The bridge's installation URL requests `read`, `write`, `app:assignable` and `app:mentionable` with `actor=app`, so the installation acts as the agent. You do not need to create or manually paste an installed access token. A personal Linear API key is not a substitute for this app installation.

Your Linear configuration should now contain:

```dotenv
LINEAR_CLIENT_ID=your-app-client-id
LINEAR_CLIENT_SECRET=your-app-client-secret
LINEAR_WEBHOOK_SECRET=your-app-webhook-signing-secret
INSTALL_SECRET=your-own-random-secret-at-least-16-characters
```

Generate `INSTALL_SECRET` locally, for example with `openssl rand -hex 32`, and save the result in `.env`. This is a separate secret protecting the bridge's installation endpoint. Store credentials in the service environment or private configuration file, never in issues, commits or chat. A webhook endpoint test will only succeed after the bridge starts in the next step.

### 4. Start and install the app

From the bridge checkout:

```sh
npm run typecheck
npm run build
npm start
```

In another terminal, check the listener and signed webhook intake:

```sh
curl http://127.0.0.1:8787/healthz
npm run smoke:webhook
```

Then privately open this URL in your browser, substituting your domain and install secret:

```text
https://your-domain.example/linear/install?install_secret=YOUR_INSTALL_SECRET
```

Choose the intended Linear workspace and authorize the app. The callback displays **T3Code bridge is installed in Linear** when installation succeeds. The bridge stores the access and refresh tokens privately at `TOKEN_STORE_PATH` (default `./data/linear-tokens.json`). Keep the install URL out of shared messages and proxy logs; the endpoint also accepts the secret in an Authorization Bearer header.

Verify the installed app identity:

```sh
npm run smoke:linear
```

The health and smoke checks do not start a coding task or establish end-to-end readiness.

### 5. Verify a disposable delegation

Create a disposable repository and an issue in a labelled Linear project. Delegate that issue to your installed app, then verify its T3Code thread, selected workspace, draft PR and reported validation results. Send a follow-up and check that it updates the same PR. Exercise restart recovery, cancellation and question/approval replies using [the acceptance checklist](docs/acceptance/nor-173.md). To test Linear's native stop signal, open the active agent session's menu and select **Send stop request** (see [Linear's signal documentation](https://linear.app/developers/agent-signals)). Allow enough time to find the control before the test turn finishes.

Use your own process supervisor for ongoing operation. An optional user-systemd template is included at [systemd/linear-t3code-agent.service.template](systemd/linear-t3code-agent.service.template). This project does not provision accounts, hosting or a supervisor.

## Status-driven workflows

In **Settings → Teams → your team → Issue statuses → Edit**, add exactly one standalone marker to the status description. Ordinary prose can surround it:

```text
Ready to challenge assumptions and clarify requirements.

t3code: grill-me
```

| Marker | Required operator-installed skill | Output |
| --- | --- | --- |
| `t3code: grill-me` | `grill-me` | Parent comments containing Q&A, decisions and uncertainty |
| `t3code: to-spec` | `to-spec` | Current specification in the parent issue description |
| `t3code: to-tickets` | `to-tickets` | Reviewed native Linear children, acceptance criteria and blocking links |
| `t3code: implement` | `implement` | Validated work and a reviewable draft PR |

Markers are case-sensitive, with exactly one space after the colon; surrounding whitespace is allowed. Multiple markers, unsupported references or malformed marker lines pause with correction instructions. Unmarked statuses are holding/review states. Selection uses the actual team and status IDs, never their names. This configuration applies across the team's projects and cannot override routing, models or permissions.

Install and maintain these skills in the selected provider's T3Code execution environment. The bridge checks the provider's workspace skill catalog through `server.refreshProviders` before starting a stage; disabled, non-user-invocable, missing or ambiguous skills block execution. It does not install or synchronize skills. It invokes the installed skill and preserves its review requirements. Linear publication instructions override target-repository tracker defaults for these workflows.

Both delegation to the installed app and a marked status are required. Initial delegation starts the selected stage. The bridge verifies the latest Linear Agent Session for the installed app using source creation times; delayed webhooks cannot take ownership back. A replacement session waits for superseded providers to stop, and superseded sessions cannot resume. Missing or ambiguous session identity prevents execution. Later Issue state/delegate updates cause a fresh current-state check; unrelated board movement cannot create a session. Subscribe the OAuth webhook to **Issue updates as well as Agent Session events**. Editing a status description alone does not start work or change an active stage. New invocations resolve the current marker and skill. Follow-ups retain the current stage and refresh Linear context.

Humans move the parent forward or backward among planning stages. These transitions reuse its planning thread. Delegating a child starts a fresh implementation thread with the current ticket, parent specification, decisions and dependencies. Small issues can enter implementation directly; moving from planning into implementation on the same issue also starts fresh while retaining its branch, workspace and PR state. Returning to planning restores its saved conversation. Implementation follow-ups reuse the current implementation thread and open PR.

A stage change, move to an unmarked status or removal of delegation stops execution first. Old questions, responses and queued prompts become inactive. The bridge confirms provider stop, then rechecks current status/delegation so rapid moves cannot launch intermediate stages. A failed transition stop retains capacity and checkout ownership; repair T3Code and send `resume` to retry the stop. Explicit `cancel` retires pending publication as well as queued work; later feedback cannot publish the cancelled draft. Publication checks cancellation again after its preflight reads, before sending a write. Already accepted remote changes remain preserved. Explicit `cancel` retains its existing terminal current-checkout behavior. `resume` cannot bypass the status/delegation gate or reopen an ended session.

### Artifacts and revisions

The parent description is the authoritative brief/specification. Parent comments retain grilling discussions and revision summaries. Children contain scope, acceptance criteria and a source-spec link; no duplicate full specification is needed. Planning requires no code changes, validation command, PR, repository Markdown, GitHub tickets or separate Linear document.

The installed skill returns structured publication content to the bridge after any required human review. The bridge publishes it with durable operation and child identities, verifies/reconciles writes, then reports completion. Child creation does not delegate work. Stable child keys are reused on re-entry and replacement delegation. After predecessor execution has stopped, the replacement inherits its child/dependency identity ledger before collecting context. Keys such as `constructor` and `__proto__` are treated as ordinary own keys. Unstarted children and their blocking links are reconciled; active, completed or delegated children retain their commitments and get proposed changes reported for human review. Omitted children are preserved and identified as possibly stale.

A rejected publication plan (for example, duplicate child keys) remains incomplete and accepts corrected feedback; planning completion is reported only after successful publication. Each accepted turn durably retains the child titles and descriptions supplied in its context. Child revisions are checked against that snapshot, including after restart, so human edits during generation are preserved. If the baseline is unavailable or a human changes an artifact during generation or publication, the bridge pauses rather than overwrite the change. Send revision feedback to start a refreshed turn in the current stage; the failed publication stays in history. Connection failures retry the retained operation after reading its remote identity/content, so a lost acknowledgement does not create a replacement artifact. Do not clear the database to repair publication. An interrupted publication may be partially applied; the next stage reads current artifacts and receives their retained identities.

Completing a stage never moves the board. Planning completion requires its actual Linear output; implementation still requires honest validation and a draft PR. See [NOR-197 acceptance](docs/acceptance/nor-197.md) for verified behavior and live acceptance prerequisites.

## Routing and permissions

The bridge reads the selected child of the **T3Code project** project label group and matches its name exactly, case-sensitively, against active T3Code project titles. Deleted projects are excluded. Missing projects/groups/selections, multiple groups or selections, unknown titles and duplicate matching titles pause the session before execution. Duplicate-title errors list the matching workspace paths. Correct the labels or T3Code configuration, then send `resume`. Duplicate webhook delivery and ordinary follow-ups do not retry failed initial resolution.

Provider/model choices come from T3Code's project overrides and environment defaults, with provider availability checked before work starts. A null snapshot override inherits the environment; a cleared effective model pauses until configured. The bridge does not choose a fallback model. Workspace precedence is the T3Code project setting, then repository `t3.json`, then the environment default. JSONC comments and trailing commas in `t3.json` are supported.

- **New worktree:** T3Code prepares the worktree using its supported turn bootstrap, locations, start-from-origin preference, and configured setup script. The repository default branch is selected, falling back to the checked-out branch when no default is known.
- **Current checkout:** the bridge reserves the canonical checkout path, then creates a task branch from current HEAD in that checkout. Existing files are preserved. Git failures pause with correction instructions. The reservation survives completed turns, idle periods, PR feedback, pauses and restarts. It covers bridge sessions; manual editor and shell activity remains outside it. If you change the checked-out branch manually, restore the session branch before resuming.

A competing current-checkout session pauses and identifies the occupying session. Once that session ends through PR closure/merge or confirmed cancellation, send `resume` to the waiting session. It never starts automatically when the checkout becomes free. Independent worktree sessions can run concurrently within `MAX_CONCURRENT_SESSIONS`.

The resolved project, workspace, model selection, workspace mode and branch/worktree identity persist for the session. Later renames, label edits and settings changes apply to new sessions. Issue text cannot select an arbitrary checkout. `PROJECT_ROUTES`, `T3CODE_PROVIDER` and `T3CODE_MODEL` are no longer used; this change has no legacy routing fallback or old-session migration.

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
