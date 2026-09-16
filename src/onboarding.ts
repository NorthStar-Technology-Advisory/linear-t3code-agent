import { installLinear } from "./setup-install.js";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { setupUrl } from "./config-schema.js";
import { parse } from "dotenv";

const args = process.argv.slice(2);
const mode = args.shift();
const file = path.resolve(process.env.DOTENV_CONFIG_PATH || ".env");
let source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
const values = parse(source);
async function save(key: string, value: string) {
  // Single-quoted dotenv values preserve literal backslashes and double quotes.
  if (/[\r\n']/.test(value)) throw new Error("Value contains unsupported newline or single quote; edit the private environment file directly.");
  const line = `${key}='${value}'`;
  // Match complete dotenv assignments, including quoted multiline values, so an
  // assignment-looking line inside an unrelated value is never replaced.
  const assignments = /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=[ \t]*|:[ \t]+)(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^\r\n]*)[^\r\n]*/gm;
  let replaced = false;
  source = source.replace(assignments, (assignment, name: string) => {
    if (name !== key) return assignment;
    replaced = true;
    return line;
  });
  if (!replaced) source = `${source}${source.endsWith("\n") || !source ? "" : "\n"}${line}\n`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file); await chmod(file, 0o600);
  values[key] = value;
}
async function setup() {
  const replaceIndex = args.indexOf("--replace");
  const replace = replaceIndex >= 0 ? args[replaceIndex + 1] : undefined;
  const allowed = ["BASE_URL", "T3CODE_URL", "T3CODE_TOKEN", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET", "SETUP_ISSUE"];
  if (replaceIndex >= 0 && (!replace || !allowed.includes(replace))) throw new Error(`Use --replace with one of: ${allowed.join(", ")}.`);
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (key: string, label: string, secret = false, validate: (value: string) => boolean = Boolean, fallback?: string) => {
    if (values[key] && replace !== key && validate(values[key])) return;
    while (true) {
      process.stdout.write(`${label}: `); hidden = secret && Boolean(process.stdin.isTTY);
      const answer = await lines.next(); hidden = false;
      if (secret && process.stdin.isTTY) process.stdout.write("\n");
      if (answer.done) throw new Error("Setup interrupted; saved answers are retained. Run npm run setup again to continue.");
      const value = answer.value.trim() || fallback || "";
      if (!validate(value)) { console.log(`Invalid ${key}; enter a valid value.`); continue; }
      await save(key, value); return;
    }
  };
  try {
    console.log("Guided bridge setup. Existing values are preserved; use --replace KEY for a correction. See docs/operations.md for HTTPS and credentials.");
    await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!values.INSTALL_SECRET) await save("INSTALL_SECRET", randomBytes(32).toString("hex"));
    await ask("BASE_URL", "Public HTTPS bridge address", false, value => setupUrl(value, true));
    const callback = new URL("/linear/oauth/callback", values.BASE_URL).href;
    if (!values.LINEAR_REDIRECT_URI || replace === "BASE_URL") await save("LINEAR_REDIRECT_URI", callback);
    let detectedUrl: string | undefined;
    if (!values.T3CODE_URL) {
      try {
        const response = await fetch("http://127.0.0.1:3773/api/orchestration/snapshot", { signal: AbortSignal.timeout(1000), redirect: "error" });
        if (response.status === 401 || response.status === 403 || (response.ok && Array.isArray((await response.json() as { projects?: unknown }).projects))) {
          detectedUrl = "http://127.0.0.1:3773";
          console.log("Detected a possible T3Code instance at http://127.0.0.1:3773; confirm it below.");
        }
      } catch { /* Manual fallback is always available. */ }
    }
    await ask("T3CODE_URL", detectedUrl ? `T3Code address [Enter for ${detectedUrl}]` : "T3Code address (usually http://127.0.0.1:3773)", false, setupUrl, detectedUrl);
    if (!values.T3CODE_TOKEN || replace === "T3CODE_TOKEN") console.log("On the T3Code host, run t3 auth session issue --label bridge --ttl 30d --token-only (with --base-dir for that instance if needed). Paste the result below; renew manually before expiry. See docs/operations.md.");
    await ask("T3CODE_TOKEN", "T3Code bearer credential (hidden)", true);
    if (!values.LINEAR_CLIENT_ID) {
      const link = new URL("https://linear.app/settings/api/applications/new");
      for (const [key, value] of Object.entries({ distribution: "private", "oauth.client_name": "T3Code Agent", "display.description": "Connects issue agent sessions to your T3Code environment.", "oauth.client_uri": "https://github.com/NorthStar-Technology-Advisory/linear-t3code-agent", "oauth.redirect_uris": values.LINEAR_REDIRECT_URI, "oauth.grant_types": "authorization_code", "webhook.enabled": "true", "webhook.url": new URL("/linear/webhook", values.BASE_URL).href })) link.searchParams.set(key, value);
      link.searchParams.append("webhook.resourceTypes", "AgentSessionEvent"); link.searchParams.append("webhook.resourceTypes", "Issue");
      console.log(`Use your existing OAuth app if already created; otherwise review this pre-filled form:\n${link}\nSupply your developer name and review the website, workspace and agent settings. Save the app and paste its generated credentials. Never create a second app just to resume setup.`);
    } else console.log("Reusing existing Linear application. For missing credentials, open that app in Settings → API.");
    await ask("LINEAR_CLIENT_ID", "Linear application Client ID");
    await ask("LINEAR_CLIENT_SECRET", "Linear Client secret (hidden)", true);
    await ask("LINEAR_WEBHOOK_SECRET", "Linear webhook signing secret (hidden)", true);
    console.log('Add a t3code YAML code block to your Linear project detailed description (see README → Project configuration). Set project to the exact active T3Code project title and map your team status names to prompts and outputs. No UUID mapping is needed.');
    await ask("SETUP_ISSUE", "An existing issue identifier in that project (read-only check; no delegation)");
    return await installLinear({ ...values, ...process.env }, args, () => lines.next());
  } finally { rl.close(); }
}
try {
  if (mode !== "setup" && mode !== "doctor") throw new Error("Usage: npm run setup [-- --replace KEY] [--reconnect-linear] or npm run doctor [-- --issue NOR-123]");
  const ready = mode === "doctor" || await setup();
  if (ready) {
    const { doctor } = await import("./doctor.js");
    process.exitCode = await doctor({ ...values, ...process.env }, args);
  } else {
    console.log("Setup paused before Linear authorization completed. Saved settings are preserved; rerun npm run setup to continue. Use npm run doctor for independent diagnostics.");
    process.exitCode = 1;
  }
} catch (error) {
  // Never echo raw network errors, command output or supplied values.
  console.error(error instanceof Error && /^(Setup interrupted|Use --replace|Usage:|Value contains)/.test(error.message) ? error.message : "Setup could not read or save private configuration. Check file access and rerun; existing session and installation state was not reset.");
  process.exitCode = 1;
}
