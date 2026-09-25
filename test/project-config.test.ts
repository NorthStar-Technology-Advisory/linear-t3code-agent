import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import { parseProjectConfig, readProjectConfig } from "../src/project-config.js";

function config() {
  return { t3code: { version: 1, project: "Zenith", workflows: [{ team: "NOR", statuses: {
    Todo: { prompt: "First line.\n\nSecond paragraph: keep this.\n", output: "draft-pr" },
  } }] } };
}
const fence = (value: unknown, label = "yaml") => `Ordinary project prose\n\n\`\`\`${label}\n${stringify(value)}\`\`\`\nMore prose.`;

test("Linear Markdown preserves multiline prompts, defaults and unrelated code blocks", () => {
  for (const label of ["yaml", "yml", ""]) {
    const result = parseProjectConfig("```js\nconst x = 1;\n```\n" + fence(config(), label));
    assert.equal(result.project, "Zenith");
    assert.equal(result.workflows[0]!.statuses.Todo!.prompt, config().t3code.workflows[0]!.statuses.Todo.prompt);
    assert.equal(result.workflows[0]!.statuses.Todo!["new-thread"], false);
    assert.deepEqual(result.workflows[0]!.statuses.Todo!["required-skills"], []);
  }
  assert.equal(parseProjectConfig(fence(config()).replaceAll("```", "~~~~")).project, "Zenith");
});

test("configuration fails closed for ambiguous blocks, YAML errors and unsupported settings", () => {
  const valid = fence(config());
  const invalid = ["No config", valid + "\n" + valid, valid.replace("version: 1", "version: 2"),
    valid.replace("version: 1", "version: 1\n  version: 1"),
    valid.replace("output: draft-pr", "output: unknown"),
    valid.replace("output: draft-pr", "output: draft-pr\n        new-thread: 'true'"),
    valid.replace("output: draft-pr", "output: draft-pr\n        surprise: true"),
    valid.replace("project: Zenith", "project: !unsafe Zenith"),
    valid.replace("project: Zenith", "project: *missing"),
    valid.replace(/```\nMore prose\.$/, ""),
    "```yaml\nt3code: [broken\n```",
  ];
  for (const content of invalid) assert.throws(() => parseProjectConfig(content), /Correct the t3code YAML/);
});

test("duplicate team entries and missing required output are rejected", () => {
  const input = config(); input.t3code.workflows.push(structuredClone(input.t3code.workflows[0]!));
  assert.throws(() => parseProjectConfig(fence(input)), /Each team/);
  assert.throws(() => parseProjectConfig(fence(config()).replace("        output: draft-pr\n", "")), /output/);
});

test("explicit agent-managed output accepts direct Linear workflow prompts", () => {
  const input = config();
  input.t3code.workflows[0].statuses.Todo.output = "agent-managed";
  assert.equal(parseProjectConfig(fence(input)).workflows[0]!.statuses.Todo.output, "agent-managed");
});

test("external-review output accepts a passive review stage", () => {
  const content = '```yaml\nt3code:\n  version: 1\n  project: Zenith\n  workflows:\n    - team: NOR\n      statuses:\n        Ready for review:\n          output: external-review\n          prompt: Wait for CodeRabbit.\n```';
  assert.equal(parseProjectConfig(content).workflows[0].statuses["Ready for review"].output, "external-review");
});

test("resolves exact team/status names to IDs across paginated collections", async () => {
  const query = async <T>(text: string, variables?: Record<string, unknown>): Promise<T> => {
    if (text.includes("BridgeProjectConfig")) return { project: { content: fence(config()) } } as T;
    const second = Boolean(variables?.after);
    const pageInfo = { hasNextPage: !second, endCursor: second ? null : "next" };
    if (text.includes("BridgeProjectTeams")) return { project: { teams: { nodes: second ? [{ id: "team-id", key: "NOR" }] : [], pageInfo } } } as T;
    assert.equal(variables?.id, "team-id");
    return { team: { states: { nodes: second ? [{ id: "status-id", name: "Todo" }] : [], pageInfo } } } as T;
  };
  const resolved = await readProjectConfig(query, "project-id");
  assert.deepEqual(resolved.statuses.map(s => [s.teamId, s.statusId]), [["team-id", "status-id"]]);
});

test("missing or ambiguous teams/statuses and stalled pagination prevent resolution", async () => {
  for (const failure of ["team", "status", "duplicate", "pagination"]) {
    const query = async <T>(text: string): Promise<T> => {
      if (text.includes("BridgeProjectConfig")) return { project: { content: fence(config()) } } as T;
      const pageInfo = { hasNextPage: failure === "pagination", endCursor: "same" };
      if (text.includes("BridgeProjectTeams")) return { project: { teams: { nodes: [{ id: "team", key: failure === "team" ? "OTHER" : "NOR" }], pageInfo } } } as T;
      const status = { id: "todo", name: "Todo" };
      return { team: { states: { nodes: failure === "status" ? [] : failure === "duplicate" ? [status, { ...status, id: "other" }] : [status], pageInfo } } } as T;
    };
    await assert.rejects(readProjectConfig(query, "project"), /Correct the t3code YAML/);
  }
});
