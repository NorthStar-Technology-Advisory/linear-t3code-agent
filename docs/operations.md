# Operations and cutover

## Existing installation

The service retains `com.northstar.linear-t3code-agent`, `dist/server.js`, `/linear/webhook` and port 8787. Run it with Node 24+. Dotenv reads the working directory's private `.env`. The old service may be disabled/unloaded: inspect launchd before changing it. Keep Crescendo, recovery watchers and all retired execution services disabled.

On this installation the source checkout is `/Users/graham/code/northstar/linear-t3code-agent` (canonical `/Volumes/Dev/repos/northstar/linear-t3code-agent`). The existing LaunchAgent is `~/Library/LaunchAgents/com.northstar.linear-t3code-agent.plist`. Its log is `data/bridge-runtime.log`. Tailscale Funnel previously maps HTTPS port 10000 to localhost:8787; inspect `tailscale serve status` before reusing it. Endpoint routing remaining configured does not prove a listener is running.

## Preparation

1. Review the replacement and run typecheck, the complete HTTP test suite, clean build and npm audit.
2. Preserve a private backup of the current `.env`, supervisor configuration and historical runtime data. Never initialise the forwarder against `data/bridge.sqlite`. Avoid overwriting another checkout's changes.
3. Configure `T3_WEBHOOK_URL` to the existing signed native dispatcher task. Obtain the correct **source** Linear signing secret; the old OAuth app's `LINEAR_WEBHOOK_SECRET` may not match the current native Linear webhook. Configure `T3_WEBHOOK_SECRET` when the destination secret differs. Store secrets only through the existing private setup/secret flow, never in Git, chat, logs or shell history. Do not turn off destination signature validation.
4. Populate `data/forwarder-policy.json` from the live enabled project registry and team state UUIDs; review it with the current workflow. Keep this small routing configuration aligned when projects/states change. It owns no tickets or stage reservations.
5. Build the release cleanly. Use the tested release worktree as the service working directory, or update the canonical checkout only through its normal review/merge/deployment process. Ensure the supervisor uses the validated Node 24 binary and replacement build.
6. `npm run doctor` validates configuration only. Test the receiver locally using a signed **irrelevant** event and verify the response is filtered, with no downstream request. HTTP integration tests prove the positive forwarding path against a fake destination, avoiding accidental real task launches.

## Cutover

1. Start the replacement receiver, confirm `/healthz` and signed irrelevant-event filtering, and retain the existing direct Linear→T3 route until ready.
2. Change the **existing** Linear webhook URL to the public `/linear/webhook` filter endpoint. Retain its source secret/resource subscription and the native T3 destination task. Avoid creating duplicate subscriptions.
3. Verify actual Linear delivery in the receiver's safe audit log. A routine comment/Backlog edit should produce no dispatcher wake; use normal owner-approved work to confirm the next genuine stage transition arrives once.
4. Keep the twenty-minute reconciliation, native input, PR watches and all owner holds unchanged. Update the shared workflow's transport note to describe the forwarding hop while retaining native orchestration ownership.
5. On failure, restore the prior **direct Linear→T3 URL**. Never roll back by restarting the old execution bridge alongside native owners.

For a macOS LaunchAgent, keep `ProgramArguments` set to the absolute Node binary plus the release's `dist/server.js`, and `WorkingDirectory` to that release. Set `RunAtLoad` and `KeepAlive` only when the replacement is ready. Restart with the normal `launchctl bootstrap` / `kickstart` lifecycle. Use the actual service domain and checked paths. Changing a plist alone does not reload a running service.

## Failures and retries

- Invalid signatures, future/expired timestamps and invalid signed payloads are rejected before forwarding.
- Relevant requests are acknowledged only after a successful downstream 2xx. Rejections, redirects and timeouts return 503, allowing Linear retries. An uncertain acceptance may be delivered twice; T3 still reconciles authoritative stage/owner identity.
- Digest receipts persist for seven days. An interrupted pending receipt becomes eligible after ten seconds. Do not clear the database to repair a network error.
- The receiver does not queue events or refresh their timestamps/signatures. Retries outside the freshness window and dependency-only edits are handled by the existing scheduled reconciliation.
- Logs contain outcome/reason counts, not issue text, secrets or token-bearing URLs. Do not enable request-body/debug logging at the proxy.

## Historical data

`bridge.sqlite`, `linear-tokens.json`, `oauth-states.json`, old worktrees and logs remain archival. The executable replacement does not import, migrate, renew, replay or clean them. Retired OAuth/agent/PR URLs return 404. Old unrelated `.env` variables are ignored and may be retired separately after reviewing retention/revocation requirements.
