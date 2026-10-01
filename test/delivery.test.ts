import assert from "node:assert/strict";
import { test } from "node:test";
import { agentManagedComplete, agentManagedResponse, deliveryResult } from "../src/delivery.js";

function report(summary: string, status = "complete", blockers: string[] = []) {
  return { status, summary, validation: [], blockers, context: { read: ["issue"], summarized: [], unavailable: [] } };
}

test("tagged result-only Retro findings survive machine-block removal", () => {
  const findings = "Priority: high. Evidence: PR #42. Impact: lost context. Recommendation: preserve the handover.";
  const text = `<bridge-result>${JSON.stringify(report(findings))}</bridge-result>`;
  assert.equal(agentManagedResponse(text), findings);
  const result = deliveryResult(text, "comment", true);
  assert.equal(result.complete, true);
  assert.equal(result.summary, findings);
  assert.ok(result.body.includes(findings));
  assert.ok(!result.body.includes("<bridge-result>"));
});

test("detailed Retro publication retains findings accompanying a short tagged or bare summary", () => {
  const findings = "Evidence and recommended actions\n".repeat(400) + "Final outstanding decision";
  for (const tail of [JSON.stringify(report("Retro complete")), `<bridge-result>${JSON.stringify(report("Retro complete"))}</bridge-result>`]) {
    const text = `${findings}\n\n${tail}`;
    const result = deliveryResult(text, "comment", true);
    assert.equal(result.complete, true);
    assert.ok(result.summary?.includes(findings));
    assert.ok(result.body.includes("Final outstanding decision"));
    assert.ok(!result.body.includes('"status":"complete"'));
  }
});

test("ordinary comment stages continue publishing their declared summary", () => {
  const text = `Supporting explanation\n\n<bridge-result>${JSON.stringify(report("Agreed decision"))}</bridge-result>`;
  assert.equal(deliveryResult(text, "comment").summary, "Agreed decision");
});

test("agent-managed completion honors explicit incomplete reports and blockers", () => {
  assert.equal(agentManagedComplete("Detailed plain-language findings"), true);
  assert.equal(agentManagedComplete(JSON.stringify(report("Source unavailable", "incomplete", ["Missing review thread"]))), false);
  assert.equal(agentManagedComplete(`<bridge-result>${JSON.stringify(report("Findings", "complete", ["Unresolved decision"]))}</bridge-result>`), false);
  assert.equal(agentManagedComplete("<bridge-result>invalid</bridge-result>"), false);
});
