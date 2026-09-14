import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
const exec = promisify(execFile);
async function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", 'const {config,projectRoutes,publicConfig}=await import("./src/config.ts");console.log(JSON.stringify({config,projectRoutes,publicConfig:publicConfig()}))'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: "/dev/null",
      LINEAR_CLIENT_ID: "client", LINEAR_CLIENT_SECRET: "secret", LINEAR_WEBHOOK_SECRET: "webhook", INSTALL_SECRET: "",
      LINEAR_REDIRECT_URI: "https://example.com/linear/oauth/callback", BASE_URL: "https://example.com",
      T3CODE_URL: "http://localhost:3773", T3CODE_TOKEN: "private-t3-token", T3CODE_PROVIDER: "codex", T3CODE_MODEL: "default-model",
      PROJECT_ROUTES: JSON.stringify({ "project-1": { repository: "/tmp/repo", t3ProjectId: "t3-project" } }), ...overrides },
  });
  return JSON.parse(stdout);
}
test("project routes inherit provider/model defaults and support explicit overrides without a Pi runtime", async () => {
  const result = await loadConfig();
  assert.deepEqual(result.projectRoutes["project-1"], { repository: "/tmp/repo", t3ProjectId: "t3-project", provider: "codex", model: "default-model", baseBranch: "main" });
  assert.equal(result.config.PI_TIMEOUT_MS, undefined);
  const custom = await loadConfig({ PROJECT_ROUTES: '{"project-1":{"repository":"/tmp/repo","t3ProjectId":"t3-project","provider":"claude","model":"other","baseBranch":"develop"}}' });
  assert.equal(custom.projectRoutes["project-1"].provider, "claude");
  assert.equal(custom.projectRoutes["project-1"].model, "other");
});
test("invalid routing, credential-bearing URLs and nonpositive concurrency fail startup", async () => {
  for (const env of [{ PROJECT_ROUTES: "not JSON" }, { PROJECT_ROUTES: '{"p":{"repository":"relative","t3ProjectId":"t3"}}' }, { T3CODE_URL: "http://user:password@localhost" }, { MAX_CONCURRENT_SESSIONS: "0" }, { T3CODE_TOKEN: "" }]) await assert.rejects(loadConfig(env));
});
test("public configuration omits credentials and private instance connection details", async () => {
  const result = await loadConfig();
  assert.equal(result.publicConfig.mappedProjectCount, 1);
  assert.equal(result.publicConfig.maxConcurrentSessions, 1);
  assert.doesNotMatch(JSON.stringify(result.publicConfig), /private-t3-token|localhost|secret|webhook/);
});
