# Operations and troubleshooting

Use the [quickstart](../README.md#quickstart-existing-linear-and-t3code-installations) first. Run one bridge process per database, on the same host/account as T3Code when possible. Remote setups require a shared filesystem with identical absolute repository, worktree and context paths. T3Code project selection is not a filesystem sandbox.

## Credentials and reconnection

The verified T3Code CLI supports:

```sh
t3 auth session issue --label bridge --ttl 30d --token-only
```

Run this on the T3Code host under its OS account, against the running instance's data directory. If customized, add `--base-dir /absolute/t3-data-directory` (equivalent to `T3CODE_HOME`; runtime data lives beneath `userdata`). The issued bearer has administrative scopes, including the orchestration, settings/provider and VCS reads the bridge needs. The explicit TTL is 30 days from issuance. Expiry or revocation causes authentication rejection. It is stored by T3Code and survives ordinary restarts; it is not the desktop bootstrap token which can be replaced on restart. `t3 auth session list` lists session expiry without revealing tokens. `t3 auth session revoke SESSION_ID` revokes an old credential after replacement.

For manual renewal, issue a new token, run `npm run setup -- --replace T3CODE_TOKEN`, paste it into the hidden prompt and restart the bridge. Doctor then rechecks authentication. There is no bearer refresh token or automatic renewal in this flow. Do not read browser API responses to obtain credentials. If your installed `t3` lacks this command, use a compatible installed CLI or consult its supported authentication procedure; do not substitute a relay or pairing token.

For other corrections, use `npm run setup -- --replace KEY`. Supported keys are `BASE_URL`, `T3CODE_URL`, `T3CODE_TOKEN`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, and `SETUP_ISSUE`. Replacing BASE_URL also derives a new redirect URI; update the existing Linear app's redirect and webhook URLs together. Existing secrets are never silently regenerated. Missing/invalid advanced settings can be corrected directly in the private environment file, using `.env.example` as a reference.

Setup reads `.env`, or `DOTENV_CONFIG_PATH` if set, and saves each answer atomically with mode 0600. Unrelated settings are preserved. Keep it out of version control and backups with broad access. Setup does not clear `TOKEN_STORE_PATH`, `STATE_STORE_PATH`, `BRIDGE_DB_PATH` or worktrees. Run commands with the same environment/file as the service; restart after changing it. Runtime environment variables take precedence over `.env`, as in dotenv; avoid stale shell exports when diagnosing.

## Install the Linear app

Keep the bridge running with the same checkout/environment as setup, then run `npm run setup`. Setup checks local and public health, requests an authorization link from the running bridge using the installation secret in an Authorization header, and opens Linear in your default browser. The secret is never included in the browser URL or printed. Approve the app for the intended workspace; setup detects the token file and continues to diagnostics automatically.

If the bridge is stopped or its settings are stale, setup prompts you to start/restart it and press Enter to retry. For a headless host, use `npm run setup -- --no-browser` and open the displayed Linear authorization link on your own computer. Browser-launch failure provides the same fallback. If authorization fails or the link expires, press Enter to obtain a fresh link. If input closes, setup exits incomplete; finish approval and rerun setup. Ctrl+C and reruns preserve configuration, installations and sessions.

A saved unexpired installation skips the browser step and is validated by doctor. To replace a revoked or incorrect installation, run `npm run setup -- --reconnect-linear`; the old token file remains intact until a successful OAuth callback replaces it.

The existing OAuth flow requests `read`, `write`, `app:assignable` and `app:mentionable` with `actor=app`. Choose the intended workspace and authorize. The callback displays **T3Code bridge is installed in Linear** and stores access/refresh tokens privately at `TOKEN_STORE_PATH` (default `./data/linear-tokens.json`). Never paste a personal API key into that store. If authorization expires, the running bridge normally refreshes it; doctor intentionally does not refresh or write tokens. If revoked, reconnect the **same app** using `npm run setup -- --reconnect-linear`. Preserve the database and context files.

The [supported Linear manifest contract](https://linear.app/developers/oauth-app-manifests) permits the application name, description, website, redirect URI and webhook configuration. Setup supplies those with `AgentSessionEvent` and `Issue` subscriptions. Developer identity and any additional agent controls must be reviewed in the form. Applications cannot use “Linear” in their names; the default is **T3Code Agent**.

## Public HTTPS

Keep T3Code private. Expose only the bridge. The bridge listens on `127.0.0.1:8787` by default. Forward `/linear/webhook`, `/linear/oauth/callback` and protected `/linear/install`; expose `/healthz` for doctor. A health response proves liveness, not signed webhook intake or actual Linear receipt.

One persistent option is a **named Cloudflare Tunnel** with a hostname you control. Install cloudflared yourself, authenticate it, create a named tunnel, and add its DNS route using Cloudflare's [local tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/). For example:

```sh
cloudflared tunnel login
cloudflared tunnel create t3code-bridge
cloudflared tunnel route dns t3code-bridge bridge.your-domain.com
```

In your private cloudflared configuration, use your actual tunnel UUID and credential file path:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /absolute/private/path/YOUR-TUNNEL-UUID.json
ingress:
  - hostname: bridge.your-domain.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run `cloudflared tunnel run t3code-bridge`, then configure cloudflared's [service operation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/) for your OS. A named tunnel retains the hostname across restarts. Provisioning and service installation are operator steps; setup does not do them. Do not put an interactive access-login page in front of webhook or callback routes.

Alternatively, point DNS to a host running Caddy with ports 80/443 reachable, and use a Caddyfile such as:

```caddyfile
bridge.your-domain.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy manages HTTPS for eligible public domain names; see its [automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https). Keep the bridge listener on loopback. On a separate proxy host, use a protected private connection instead. Update BASE_URL and the app URLs if the public address changes.

## Keep the bridge running

Use the service account's real environment, including the PATH needed for Node, git and gh. Resolve the installed paths with `command -v node`, `command -v git` and `command -v gh`; do not assume a package manager or hard-coded Node installation directory. Run `npm run build` after updates before restarting. Verify T3Code is also kept running by its own supervisor.

**Linux:** adapt the existing [user systemd template](../systemd/linear-t3code-agent.service.template). Replace its Node/PATH placeholders with the resolved paths and its checkout path with your actual checkout. Copy the edited unit into `~/.config/systemd/user/linear-t3code-agent.service`, then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now linear-t3code-agent
journalctl --user -u linear-t3code-agent -f
```

Arrange user lingering through your administrator if it must run without login. Consult [systemd user service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

**macOS:** use an existing process supervisor or create a per-user LaunchAgent in `~/Library/LaunchAgents/` using Apple's [launchd guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html). Set `Label` to `com.northstar.linear-t3code-agent`; `ProgramArguments` to the absolute resolved Node binary and absolute `dist/server.js`; `WorkingDirectory` to the bridge checkout; `RunAtLoad` and `KeepAlive` to true; and `EnvironmentVariables.PATH` to the service account's tool PATH. Use private writable `StandardOutPath`/`StandardErrorPath`. Dotenv loads the checkout's `.env`; no secrets need to be copied into the plist. Load your plist with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.northstar.linear-t3code-agent.plist`, and restart it with `launchctl kickstart -k gui/$(id -u)/com.northstar.linear-t3code-agent`. A LaunchAgent runs in the logged-in user session; use an operator-managed daemon or another host for unattended operation without login. No launchd wrapper is generated or installed by this project.

## Read-only diagnosis

`npm run doctor` works with incomplete configuration. It checks tools, runtime config, T3Code auth/contracts, installed Linear app identity, project YAML, team/status mappings and inherited settings, repository/Git access, GitHub authentication, context storage access, local health and public HTTPS. Supply `-- --issue NOR-123` to override the saved setup issue. An issue is read only; delegation/status is not changed.

Each failed check gives a repair step. Authentication rejection means renew/reinstall the credential; connection failure means repair the service/address/network; contract failures mean check scopes and installed versions. Missing project association means select one matching child label on the Linear project. Ambiguous active T3Code titles must be made unique. After fixing, rerun doctor. A repaired connection does not automatically resume paused coding sessions; follow the existing `resume` rules when appropriate.

Doctor does not refresh tokens, alter configuration, provision resources, create sessions/branches/worktrees, push, create PRs or post messages. An authenticated WebSocket ticket is an ephemeral transport credential needed for read RPCs. Repository access checks inspect existing permissions; actual writes remain unverified. T3Code worktree placement/setup scripts are not exercised. Public reachability is measured from the bridge host, not from Linear's infrastructure. Real webhook receipt and end-to-end delivery always remain unverified by onboarding.

Back up state consistently: stop the bridge before a filesystem backup, or use a SQLite-consistent database backup plus context and token files. SIGTERM preserves remote execution for restart recovery. Never reset the database to repair an auth or API error. See [maintainer verification](maintainer-verification.md) for optional synthetic intake and full delivery/restart/cancellation exercises.
