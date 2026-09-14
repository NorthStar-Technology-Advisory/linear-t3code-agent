import assert from "node:assert/strict";
import { test } from "node:test";
async function progressModule() { return import("../src/progress.js"); }

test("toolProgressText formats known tools safely", async () => {
  const { toolProgressText } = await progressModule();

  assert.equal(toolProgressText("bash", { command: "npm run typecheck" }), "Running bash: npm run typecheck");
  assert.equal(toolProgressText("read", { path: "src/t3code-runner.ts" }), "Running read: src/t3code-runner.ts");
  assert.equal(toolProgressText("write", { path: "README.md", content: "SECRET=abc" }), "Running write: README.md");
  assert.equal(toolProgressText("edit", { path: "src/config.ts", oldText: "TOKEN=abc", newText: "TOKEN=def" }), "Running edit: src/config.ts");
  assert.equal(toolProgressText("ls", {}), "Running ls: .");
  assert.equal(toolProgressText("ls", { path: "src" }), "Running ls: src");
  assert.equal(toolProgressText("grep", { pattern: "ProgressReporter", path: "src" }), "Running grep: ProgressReporter in src");
  assert.equal(toolProgressText("rg", { query: "ProgressReporter", glob: "src/**/*.ts" }), "Running rg: ProgressReporter in src/**/*.ts");
  assert.equal(toolProgressText("find", { pattern: "*.ts", path: "src" }), "Running find: *.ts in src");
  assert.equal(toolProgressText("web_search", { query: "Linear agent progress API" }), "Running web_search: Linear agent progress API");
  assert.equal(toolProgressText("web_search", { queries: ["Linear agent progress API"] }), "Running web_search: Linear agent progress API");
  assert.equal(toolProgressText("fetch_content", { url: "https://linear.app/developers/agent-interaction" }), "Running fetch_content: https://linear.app/developers/agent-interaction");
  assert.equal(toolProgressText("fetch_content", { urls: ["https://example.com/a?token=abc"] }), "Running fetch_content: https://example.com/a?token=redacted");
});

test("toolProgressText does not leak write or edit content", async () => {
  const { toolProgressText } = await progressModule();

  const writeText = toolProgressText("write", { path: "README.md", content: "private content" });
  const editText = toolProgressText("edit", { path: "src/config.ts", edits: [{ oldText: "old secret", newText: "new secret" }] });

  assert.equal(writeText, "Running write: README.md");
  assert.equal(editText, "Running edit: src/config.ts");
  assert.equal(writeText.includes("private content"), false);
  assert.equal(editText.includes("old secret"), false);
  assert.equal(editText.includes("new secret"), false);
});

test("toolProgressText handles unknown tools with safe allowlisted fields only", async () => {
  const { toolProgressText } = await progressModule();

  assert.equal(toolProgressText("custom_tool", { path: "src/file.ts" }), "Running custom_tool: src/file.ts");
  assert.equal(toolProgressText("custom_tool", { token: "secret", content: "private" }), "Running custom_tool");
});

test("toolProgressText redacts tokens, auth headers, GitHub tokens, CLI flags, and URLs", async () => {
  const { toolProgressText } = await progressModule();

  const text = toolProgressText("bash", {
    command: "curl -H 'Authorization: Bearer abcdefghijklmnop' --token ghp_123456789012345678901234567890123456 https://user:pass@example.com/path?access_token=abc&ok=1 OPENAI_API_KEY=sk-12345678901234567890 github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
  });

  assert.match(text, /Authorization: Bearer \[redacted\]/);
  assert.match(text, /--token \[redacted\]/);
  assert.match(text, /OPENAI_API_KEY=\[redacted\]/);
  assert.equal(text.includes("abcdefghijklmnop"), false);
  assert.equal(text.includes("ghp_123456"), false);
  assert.equal(text.includes("github_pat_123456"), false);
  assert.equal(text.includes("user:pass"), false);
  assert.equal(text.includes("access_token=abc"), false);
});

test("toolProgressText truncates long commands", async () => {
  const { toolProgressText } = await progressModule();

  const text = toolProgressText("bash", { command: "x".repeat(500) });

  assert.equal(text.length, 220);
  assert.equal(text.endsWith("…"), true);
});

test("formatElapsed returns compact elapsed time", async () => {
  const { formatElapsed } = await progressModule();

  assert.equal(formatElapsed(-1_000), "0s");
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(500), "1s");
  assert.equal(formatElapsed(999), "1s");
  assert.equal(formatElapsed(30_000), "30s");
  assert.equal(formatElapsed(60_000), "1m");
  assert.equal(formatElapsed(61_000), "1m 1s");
  assert.equal(formatElapsed(74_000), "1m 14s");
  assert.equal(formatElapsed(1_800_000), "30m");
  assert.equal(formatElapsed(3_660_000), "1h 1m");
});
