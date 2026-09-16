import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigSchema, setupUrl } from "./config-schema.js";
import { T3CodeRunner } from "./t3code-runner.js";
import { matchProject, projectTitle, type ProjectQuery } from "./project-routing.js";
import type { RunnerProject } from "./runner.js";
const exec = promisify(execFile);
const installationSchema = z.object({ default_app_user_id: z.string().optional(), installations: z.record(z.object({ access_token: z.string().min(1), expires_at: z.number(), viewer_app_user_id: z.string().optional(), scope: z.union([z.string(), z.array(z.string())]).optional() })) });
function serviceUrl(value: string | undefined) {
  try { const url = new URL(value || ""); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
export async function doctor(values: NodeJS.ProcessEnv, args: string[]): Promise<number> {
  let failed = false;
  const report = (state: "PASS" | "FAIL" | "UNVERIFIED", component: string, detail: string) => {
    if (state === "FAIL") failed = true;
    console.log(`${state} ${component}: ${detail}`);
  };
  const check = async (component: string, repair: string, action: () => Promise<string>) => {
    try { report("PASS", component, await action()); } catch { report("FAIL", component, repair); }
  };
  const config = ConfigSchema.safeParse(values);
  const base = serviceUrl(values.BASE_URL) ? new URL(values.BASE_URL!) : undefined;
  const callback = base ? new URL("/linear/oauth/callback", base).href : undefined;
  if (!config.success) report("FAIL", "configuration", `Run npm run setup; correct ${[...new Set(config.error.issues.map(i => i.path.join(".")))].join(", ")}.`);
  else if (!values.INSTALL_SECRET || values.INSTALL_SECRET.length < 16 || !setupUrl(values.BASE_URL, true) || values.LINEAR_REDIRECT_URI !== callback) report("FAIL", "configuration", "Run setup -- --replace BASE_URL; use an HTTPS origin, matching callback and an INSTALL_SECRET of at least 16 characters.");
  else report("PASS", "configuration", "Required runtime values and derived callback are valid.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  report(major > 22 || major === 22 && minor >= 13 ? "PASS" : "FAIL", "Node runtime", "Node 22.13 or newer is required.");
  for (const command of ["npm", "git"]) await check(command, `Install ${command} and include it in the service account PATH.`, async () => { await exec(command, ["--version"], { timeout: 5000 }); return "Executable available."; });
  await check("GitHub", "Install gh, then run gh auth login as the bridge service account; check connectivity with gh auth status.", async () => { await exec("gh", ["auth", "status"], { timeout: 10000 }); return "GitHub CLI authentication available; repository write permission remains unverified."; });

  let projects: RunnerProject[] | undefined;
  let runner: T3CodeRunner | undefined;
  if (!serviceUrl(values.T3CODE_URL) || !values.T3CODE_TOKEN) report("FAIL", "T3Code", "Run npm run setup to supply T3CODE_URL and T3CODE_TOKEN.");
  else {
    runner = new T3CodeRunner(values.T3CODE_URL!, values.T3CODE_TOKEN);
    try { projects = await runner.projects(); report("PASS", "T3Code", "Reachable; bearer authentication and project snapshot contract accepted."); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      report("FAIL", "T3Code", /HTTP (401|403)/.test(message) ? "Authentication rejected. Issue a replacement credential, run npm run setup -- --replace T3CODE_TOKEN, then restart the bridge. Preserve session and installation files." : /connection failed/.test(message) ? "Connection failed. Start T3Code and correct T3CODE_URL or private-network access." : "API incompatible or unavailable. Verify T3Code version and orchestration read scopes; update the adapter if its contract changed.");
    }
  }
  let query: ProjectQuery | undefined;
  try {
    const store = installationSchema.parse(JSON.parse(await readFile(values.TOKEN_STORE_PATH || "./data/linear-tokens.json", "utf8")));
    const id = store.default_app_user_id ?? Object.keys(store.installations)[0];
    const installation = store.installations[id];
    if (!installation || installation.expires_at <= Date.now()) throw new Error("installation");
    if (installation.scope) {
      const scopes = Array.isArray(installation.scope) ? installation.scope : installation.scope.split(/[ ,]+/);
      if (!["read", "write", "app:assignable", "app:mentionable"].every(scope => scopes.includes(scope))) throw new Error("scopes");
    }
    query = async <T>(queryText: string, variables?: Record<string, unknown>): Promise<T> => {
      const response = await fetch("https://api.linear.app/graphql", { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${installation.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ query: queryText, variables }) });
      if (response.status === 401 || response.status === 403) throw new Error("authentication");
      if (!response.ok) throw new Error("connection");
      const json = await response.json() as { data?: T; errors?: unknown[] };
      if (json.errors?.length || !json.data) throw new Error("schema");
      return json.data;
    };
    const viewer = await query<{ viewer: { id: string; isMe: boolean; app: boolean } }>("query DoctorViewer { viewer { id isMe app } }");
    if (!viewer.viewer?.app || viewer.viewer.id !== id) throw new Error("identity");
    report("PASS", "Linear installation", "Installed app identity matches the stored installation.");
  } catch (error) {
    query = undefined;
    const reason = error instanceof Error ? error.message : "";
    report("FAIL", "Linear installation", reason === "scopes" ? "Required app scopes are missing. Reinstall the existing app with read, write, app:assignable and app:mentionable scopes." : reason === "authentication" ? "Authentication rejected. Run npm run setup -- --reconnect-linear; preserve the database." : reason === "identity" ? "Identity is not the installed app. Complete actor=app OAuth using the existing application." : reason === "schema" ? "Identity API or scopes incompatible. Check Linear read scope and update the adapter." : reason === "connection" || error instanceof TypeError || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "Connection failed. Check access to api.linear.app, then rerun doctor." : "Missing, invalid or expired installation. Start the bridge and run npm run setup for browser authorization; for expiry let the running bridge refresh, then rerun doctor. Doctor never refreshes or writes tokens.");
  }
  const issueIndex = args.indexOf("--issue");
  const issue = issueIndex >= 0 ? args[issueIndex + 1] : values.SETUP_ISSUE;
  let selected: RunnerProject | undefined;
  if (!issue) report("FAIL", "project association", "Run npm run doctor -- --issue NOR-123 for an existing issue in the intended Linear project, or save one through setup. No delegation occurs.");
  else if (!query || !projects) report("UNVERIFIED", "project association", "Repair Linear and T3Code connection checks, then rerun with --issue.");
  else {
    try {
      const data = await query<{ issue: { project: { id: string } | null } | null }>("query DoctorIssue($id: String!) { issue(id: $id) { project { id } } }", { id: issue });
      selected = matchProject(projects, await projectTitle(query, data.issue?.project?.id));
      report("PASS", "project association", "Project YAML is valid, team/status names resolve, and exactly one active T3Code project matches.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = /Multiple T3Code/.test(message) ? "Multiple active T3Code projects match; give them unique titles." : /No active T3Code/.test(message) ? "No active T3Code project matches; correct the exact title, including case and spaces." : "Check the t3code YAML block in the project detailed description, team keys, status names and project access.";
      report("FAIL", "project association", reason);
    }
  }
  if (selected && runner) {
    await check("effective settings", "Configure an available model/provider and workspace preference in T3Code; check settings/provider read scopes and repository t3.json.", async () => {
      const settings = await runner!.execution(selected!);
      return `Inherited provider/model available; workspace mode ${settings.workspaceMode}; start from origin ${settings.startFromOrigin}.`;
    });
    await check("repository access", "Run on the same host/account or mount identical absolute paths; restore read/write access to the repository and Git metadata.", async () => {
      await access(selected!.workspaceRoot, constants.R_OK | constants.W_OK | constants.X_OK);
      const { stdout } = await exec("git", ["-C", selected!.workspaceRoot, "rev-parse", "--absolute-git-dir"], { timeout: 5000 });
      await access(stdout.trim(), constants.R_OK | constants.W_OK | constants.X_OK);
      await exec("git", ["-C", selected!.workspaceRoot, "rev-parse", "--verify", "HEAD"], { timeout: 5000 });
      return "Repository and Git metadata accessible; no branch or worktree was created.";
    });
    await check("Git identity", "Configure git user.name and user.email for the service account or selected repository.", async () => {
      for (const key of ["user.name", "user.email"]) { const result = await exec("git", ["-C", selected!.workspaceRoot, "config", "--get", key], { timeout: 5000 }); if (!result.stdout.trim()) throw new Error("missing"); }
      return "Commit identity configured.";
    });
    await check("T3Code branch access", "Check T3Code VCS read scopes and select a repository branch.", async () => { await runner!.baseBranch(selected!.workspaceRoot); return "Repository branch is readable through T3Code."; });
  } else report("UNVERIFIED", "effective settings / repository / Git identity", "Resolve the selected project first, then rerun doctor.");
  await check("worktree/context access", "Restore access to WORKTREE_ROOT or its nearest existing parent; do not delete session data.", async () => {
    let directory = path.resolve(values.WORKTREE_ROOT || "./data/worktrees");
    while (true) { try { if (!(await stat(directory)).isDirectory()) throw new Error("not directory"); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = path.dirname(directory); if (parent === directory) throw error; directory = parent; } }
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK); return "Existing parent accessible; creation and T3Code worktree placement remain unverified.";
  });
  const health = async (url: URL) => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const data = await response.json() as { ok?: boolean; service?: string };
    if (!response.ok || data.ok !== true || data.service !== "linear-t3code-agent") throw new Error("health");
    return "Bridge health response received; this proves liveness only.";
  };
  await check("bridge process", "Run npm run build and npm start; check HOST/PORT and service logs.", () => health(new URL(`http://${values.HOST || "127.0.0.1"}:${values.PORT || "8787"}/healthz`)));
  if (base?.protocol === "https:") await check("public HTTPS", "Configure the HTTPS tunnel/proxy and expose /healthz for this check. If intentionally private, reachability remains unverified until independently checked.", () => health(new URL("/healthz", base)));
  else report("FAIL", "public HTTPS", "Supply a public HTTPS BASE_URL through setup and configure forwarding to the bridge.");
  report("UNVERIFIED", "signed intake", "Optional maintainer smoke:webhook checks synthetic signing only; doctor sends no webhooks.");
  report("UNVERIFIED", "actual Linear webhook receipt", "No real Linear webhook delivery is established by health checks.");
  report("UNVERIFIED", "end-to-end delivery / write permissions", "No coding, push, PR or Linear message was attempted. Verify through normal delegation when ready.");
  console.log(failed ? "Setup incomplete. Follow the failed checks and rerun npm run doctor." : "Setup complete: configuration and available connection checks passed. Delivery and execution remain unverified. Follow README.md#status-driven-workflows for normal delegation.");
  return failed ? 1 : 0;
}
