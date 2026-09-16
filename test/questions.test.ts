import { test } from "node:test";
import assert from "node:assert/strict";
import { naturalAnswer, questionText } from "../src/questions.js";

test("lettered choices map to option labels and validate the addressed question", () => {
  const request = { questionNumber: 2, questions: [{ id: "internal", question: "Which audience?", options: [{ label: "Operators" }, { label: "Customers" }] }] };
  assert.match(questionText(request), /Question 2[\s\S]*\*\*A\.\*\* Operators[\s\S]*2A/);
  assert.equal(naturalAnswer(request, "2B"), "Customers");
  assert.equal(naturalAnswer(request, "b"), "Customers");
  assert.equal(naturalAnswer(request, "1A"), undefined);
  assert.equal(naturalAnswer(request, "2Z"), undefined);
  assert.equal(naturalAnswer(request, "A, B"), undefined);
  assert.equal(naturalAnswer(request, "Yes, please include both groups"), "Yes, please include both groups");
  assert.equal(naturalAnswer(request, "No"), "No");
});

test("message-mode multi-select answers remain strings", () => {
  const request = { responseMode: "message", questions: [{ id: "checks", question: "Checks?", multiSelect: true, options: [{ label: "Lint" }, { label: "Tests" }] }] };
  assert.equal(naturalAnswer(request, "1A, 1B"), "Lint, Tests");
});
