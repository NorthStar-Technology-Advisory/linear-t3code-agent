import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
const exec = promisify(execFile);
async function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", 'const {config,publicConfig}=await import("./src/config.ts");console.log(JSON.stringify({config,publicConfig:publicConfig()}))'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: "/dev/null",
      LINEAR_CLIENT_ID: "client", LINEAR_CLIENT_SECRET: "secret", LINEAR_WEBHOOK_SECRET: "webhook", INSTALL_SECRET: "",
      LINEAR_REDIRECT_URI: "https://example.com/linear/oauth/callback", BASE_URL: "https://example.com",
      T3CODE_URL: "http://localhost:3773", T3CODE_TOKEN: "private-t3-token", T3CODE_PROVIDER: "codex", T3CODE_MODEL: "default-model",
      PROJECT_ROUTES: JSON.stringify({ "project-1": { repository: "/tmp/repo", t3ProjectId: "t3-project" } }), ...overrides },
  });
  return JSON.parse(stdout);
}
test("startup needs no project routes or bridge provider/model defaults", async () => {
  const result = await loadConfig({ PROJECT_ROUTES: undefined, T3CODE_PROVIDER: undefined, T3CODE_MODEL: undefined });
  assert.equal(result.config.PROJECT_ROUTES, undefined);
  assert.equal(result.config.T3CODE_PROVIDER, undefined);
  assert.equal(result.config.T3CODE_MODEL, undefined);
});
test("credential-bearing URLs and nonpositive concurrency fail startup", async () => {
  for (const env of [{ T3CODE_URL: "http://user:password@localhost" }, { MAX_CONCURRENT_SESSIONS: "0" }, { T3CODE_TOKEN: "" }]) await assert.rejects(loadConfig(env));
});
test("public configuration omits credentials and private instance connection details", async () => {
  const result = await loadConfig();
  assert.equal(result.publicConfig.maxConcurrentSessions, 1);
  assert.doesNotMatch(JSON.stringify(result.publicConfig), /private-t3-token|localhost|secret|webhook/);
});
