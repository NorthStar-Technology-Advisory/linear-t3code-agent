import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const installation = z.object({ access_token: z.string().min(1), expires_at: z.number() });
async function installed(file: string): Promise<string | undefined> {
  try {
    const store = JSON.parse(await readFile(file, "utf8"));
    const id = store.default_app_user_id ?? Object.keys(store.installations ?? {})[0];
    const result = installation.safeParse(store.installations?.[id]);
    if (result.success && result.data.expires_at > Date.now()) return result.data.access_token;
  } catch { /* Missing or incomplete installation; the callback writes it atomically. */ }
}

async function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  await promisify(execFile)(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { timeout: 10000 });
}

/** Setup owns interaction; the running bridge owns OAuth state and token writes. */
export async function installLinear(
  values: NodeJS.ProcessEnv,
  args: string[],
  nextLine: () => Promise<IteratorResult<string>>,
) {
  const file = values.TOKEN_STORE_PATH || "./data/linear-tokens.json";
  const original = await installed(file);
  if (original && !args.includes("--reconnect-linear")) {
    console.log("Saved Linear installation found. Checking it with doctor next.");
    return true;
  }
  console.log("Your app credentials identify the app. One browser approval is also needed to authorize it in your Linear workspace. Setup handles the installation secret automatically; you do not need to copy another secret.");
  const host = !values.HOST || values.HOST === "0.0.0.0" ? "127.0.0.1" : values.HOST === "::" ? "[::1]" : values.HOST;
  const local = `http://${host}:${values.PORT || "8787"}`;
  const retry = async (message: string) => {
    console.log(`${message}\nPress Enter when ready to retry, or Ctrl+C to exit and rerun setup later.`);
    return !(await nextLine()).done;
  };
  let authorization: URL;
  while (true) {
    try {
      const health = await fetch(new URL("/healthz", local), { redirect: "error", signal: AbortSignal.timeout(5000) });
      const body = await health.json() as { ok?: boolean; service?: string };
      if (!health.ok || body.ok !== true || body.service !== "linear-t3code-agent") throw new Error();
    } catch {
      if (await retry("Configuration saved. In another terminal in this checkout, run npm run build and npm start (or restart the existing bridge), then return here.")) continue;
      return false;
    }
    try {
      const health = await fetch(new URL("/healthz", values.BASE_URL), { redirect: "error", signal: AbortSignal.timeout(5000) });
      const body = await health.json() as { ok?: boolean; service?: string };
      if (!health.ok || body.ok !== true || body.service !== "linear-t3code-agent") throw new Error();
    } catch {
      if (await retry("The public HTTPS address is not reaching the bridge. Configure your tunnel/proxy and check BASE_URL before browser authorization.")) continue;
      return false;
    }
    try {
      const response = await fetch(new URL("/linear/install", local), {
        headers: values.INSTALL_SECRET ? { authorization: `Bearer ${values.INSTALL_SECRET}` } : {},
        redirect: "manual", signal: AbortSignal.timeout(5000),
      });
      const location = response.headers.get("location");
      if (response.status !== 302 || !location) throw new Error();
      authorization = new URL(location);
      const params = authorization.searchParams;
      if (authorization.origin !== "https://linear.app" || authorization.pathname !== "/oauth/authorize"
        || authorization.username || authorization.password || authorization.hash
        || params.get("client_id") !== values.LINEAR_CLIENT_ID || params.get("redirect_uri") !== values.LINEAR_REDIRECT_URI
        || params.get("actor") !== "app" || params.get("response_type") !== "code" || !params.get("state")) throw new Error();
    } catch {
      if (await retry("The running bridge could not start authorization with the saved settings. Restart it from this checkout with the same environment, then retry.")) continue;
      return false;
    }
    console.log(`Check the existing Linear app uses these URLs:\nRedirect URI: ${values.LINEAR_REDIRECT_URI}\nWebhook URL: ${new URL("/linear/webhook", values.BASE_URL).href}`);
    if (!args.includes("--no-browser")) {
      try {
        await openBrowser(authorization.href);
        console.log("Opened Linear in your browser. Choose your workspace and approve access for the app.");
      } catch {
        console.log(`Could not open a browser. Open this Linear authorization link manually:\n${authorization.href}`);
      }
    } else console.log(`Open this Linear authorization link manually:\n${authorization.href}`);
    console.log("Waiting for Linear installation. Setup continues automatically after approval. If the browser reports an error or the link expires, fix it and press Enter to open a fresh link. Ctrl+C safely exits.");
    // Keep one pending stdin read while polling; never accumulate abandoned reads.
    const input = nextLine();
    while (true) {
      const token = await installed(file);
      if (token && token !== original) {
        console.log("Linear installation saved. Running connection checks now.");
        return true;
      }
      const result = await Promise.race([input, delay(1000).then(() => undefined)]);
      if (result?.done) {
        console.log("Input closed before installation completed. Finish browser authorization, then rerun setup; saved configuration is preserved.");
        return false;
      }
      if (result) break;
    }
  }
}
