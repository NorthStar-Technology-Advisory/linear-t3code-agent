# Linear ↔ T3Code agent bridge

Delegate a Linear issue to an existing T3Code environment. Each Linear Agent Session gets its own T3Code thread, git worktree and branch. The coding agent implements and tests the task, pushes the branch, and opens a draft PR for human review. Follow-ups reuse that session; the bridge never merges PRs.

Forked from [linear-pi-agent](https://github.com/hiasinho/linear-pi-agent). The Linear OAuth, signed webhook and progress-formatting foundations remain; Pi is no longer a runtime dependency.

## Setup

See [INSTALL.md](INSTALL.md). Requirements:

- Node.js **22.13 or newer**, npm, git and authenticated `gh`.
- One Linear OAuth installation and one authenticated T3Code environment.
- The bridge and T3Code run under the same dedicated account, with the same repository, worktree and context paths available. A private remote environment needs identical shared paths; the bridge does not transfer git checkouts to another host.
- Existing T3Code projects mapped explicitly to repositories and Linear project UUIDs.
- A public HTTPS endpoint for Linear, forwarded to the bridge's localhost listener.

```sh
npm ci
cp .env.example .env
# Fill in credentials, URLs and PROJECT_ROUTES.
npm run typecheck
npm run build
npm start
```

Use your own process supervisor. An optional user-systemd template is included at [systemd/linear-t3code-agent.service.template](systemd/linear-t3code-agent.service.template). This project does not provision accounts, hosting or a supervisor.

## Routing and permissions

`PROJECT_ROUTES` is JSON keyed by Linear project UUID. Each entry contains an absolute `repository`, existing `t3ProjectId`, optional `baseBranch` (default `main`), and optional `provider`/`model` overrides. Otherwise `T3CODE_PROVIDER` and `T3CODE_MODEL` apply. The provider value is T3Code's configured **provider instance ID**.

```json
{
  "linear-project-uuid": {
    "repository": "/srv/repos/example",
    "t3ProjectId": "existing-t3-project-id",
    "provider": "codex",
    "model": "your-model-id",
    "baseBranch": "main"
  }
}
```

Unknown projects are rejected. The bridge verifies the selected T3Code project's workspace root against the configured repository. Routing, provider and model are persisted when the session starts; changing configuration does not redirect existing sessions. Issue text cannot select an arbitrary checkout.

Access to this agent in the configured Linear workspace authorizes coding and draft-PR work with **full execution permissions**. Run both services under a dedicated OS account containing only intended credentials and integrations. Worktrees isolate checkouts; routing and T3Code projects are **not filesystem sandboxes**. The operator provisions that account. Keep T3Code private and use a bearer credential with only `orchestration:read` and `orchestration:operate` scopes.

## Conversations and recovery

Signed, fresh webhook intake is committed to SQLite before returning HTTP 200. Initial events deduplicate by workspace/session; follow-ups by Agent Activity ID. Queues, commands, activity outbox, routing, requests, PR state and replay positions survive restarts. Run **one bridge process per database**; a live-process ownership check prevents a second worker from executing the same queues.

The bridge reconciles T3Code snapshots and authenticated event catch-up. It retains exact command IDs across uncertain acknowledgements, using T3Code's durable command receipts. It never invents a new command ID to retry uncertain work. Linear activities have stable UUIDs and are looked up before retrying uncertain delivery. For a large replay gap, the bridge reconciles a fresh snapshot, including T3Code’s pinned pending requests, and reports that intermediate progress details are unavailable. Preserve the database and context directory when restarting or upgrading; do not delete state to repair a connection failure.

Ordinary follow-ups run in arrival order. A failed or incomplete turn pauses the queue; send `resume` to continue or `cancel` to clear it. Fix configuration/access first if that was the blocker. A later prompt resumes a cancelled session while its PR remains open. `MAX_CONCURRENT_SESSIONS` limits active sessions, including sessions waiting for an answer or for cancellation to finish.

Questions and approvals appear in Linear with request IDs:

```text
approve <request-id>
decline <request-id>
answer <request-id> {"question-id":"answer"}
```

Only explicit approval commands grant approval. Other messages stay queued. `stop`, `cancel`, and Linear's actual stop signal interrupt execution and stop the provider session, clear pending work, and preserve the thread, branch, worktree, edits and PR. New work waits until provider stop is observed. Execution and human answers have **no bridge deadline**. Thirty-second network/git operation limits only bound individual connection attempts.

## Context and delivery

Before every turn, the bridge fetches the issue, all paginated text comments with authors/dates, attachment bodies, and directly related issues with their comments and attachments. Further relationships are recorded without recursively traversing the graph. Linear-hosted uploads are downloaded with OAuth into private context files. Downloads are limited to 50 MiB each; failures and limits appear in the inventory as unavailable. Credentials are never forwarded to external URLs or redirects.

External links are supplied to T3Code for retrieval through its authorized tools. They are explicitly marked unread by the bridge. Large context is supplied as a complete private JSON file rather than truncated. T3Code is instructed to read supplied files and maintain an inventory of read, summarized and unavailable sources. If Linear material is missing and the task explicitly says it must be read, the bridge pauses before submitting the turn. T3Code handles semantic prerequisite checks and unavailable external material by asking a question before implementation.

The agent returns a structured result with validation commands, outcomes, blockers and context access. The bridge checks for the session branch's draft PR through `gh`. Missing validation, failed/unavailable checks, blockers or a missing draft are reported as incomplete, with the PR link when available. Validation is identified as **reported by T3Code**. Same-session follow-ups update the existing PR. Once it closes or merges, further implementation requires a new delegation.

On PR closure, the bridge removes the worktree only when it is clean and its commits are reachable from freshly fetched origin refs. Dirty, untracked, unpushed, unverifiable and squash-merge cases are preserved conservatively and reported. Branches and session mappings remain. Ignored files can also prevent git from removing the worktree; no force removal is used.

## Operations

| Setting | Default |
| --- | --- |
| `BRIDGE_DB_PATH` | `./data/bridge.sqlite` |
| `WORKTREE_ROOT` | `./data/worktrees` |
| `MAX_CONCURRENT_SESSIONS` | `1` |
| `POLL_INTERVAL_MS` | `1000` |
| `PR_POLL_INTERVAL_MS` | `60000` |
| `PROGRESS_DEBOUNCE_MS` | `3000` |
| `PROGRESS_HEARTBEAT_MS` | `300000` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` |

Expose `/linear/webhook`, `/linear/oauth/callback`, and the protected `/linear/install` route. `/healthz` is an optional liveness check, not evidence of external integration readiness. Keep `.env`, SQLite/WAL files, context files and token stores private. Shut down the bridge before a filesystem backup, or use a SQLite-consistent backup of the database plus its context files. SIGTERM preserves remote execution for restart recovery; it does not cancel coding work.

Run `npm test` for the integrated controlled-service suite, `npm run typecheck`, and `npm run build`. `npm run smoke:webhook` checks signed intake without creating a session; `npm run smoke:linear` checks the installed Linear identity without posting activities.

T3Code is not version-pinned. The adapter follows its authenticated [HTTP contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/environmentHttp.ts), [orchestration contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts), and [authentication model](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md). Contract/authentication failures are surfaced without response bodies or credentials. See [the acceptance record](docs/acceptance/nor-173.md) for verified behavior and remaining live validation. Automated checks alone do not establish v1 readiness.
