import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeModelInfo } from "@botiverse/raft-shared";
import {
  modelHasReasoningControl,
  reasoningEffortOptionsForModel,
  reconcileReasoningEffort,
} from "../src/utils/reasoningEffortOptions.js";

// Cursor SDK live models (task #7): the daemon reports each model's offered
// efforts derived from the SDK's parameters. The model form shows the existing
// reasoning dropdown only for models that declare a set.
const live: RuntimeModelInfo[] = [
  { id: "default", label: "Auto" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
  { id: "gpt-5.5", label: "GPT-5.5", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "xhigh" },
];

test("the dropdown lists exactly the model's declared efforts", () => {
  assert.deepEqual(reasoningEffortOptionsForModel("cursor-sdk", "claude-opus-5-5", live).map((o) => o.value), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(reasoningEffortOptionsForModel("cursor-sdk", "gpt-5.5", live).map((o) => o.value), ["low", "medium", "high", "xhigh"]);
});

test("only models that declare efforts get the control for cursor-sdk; other runtimes are unchanged", () => {
  assert.equal(modelHasReasoningControl("cursor-sdk", "claude-opus-5-5", live), true);
  assert.equal(modelHasReasoningControl("cursor-sdk", "default", live), false);
  assert.equal(modelHasReasoningControl("cursor-sdk", "unknown-model", live), false);
  assert.equal(modelHasReasoningControl("cursor-sdk", "claude-opus-5-5", undefined), false);
  assert.equal(modelHasReasoningControl("codex", "gpt-5.5", live), true);
  assert.equal(modelHasReasoningControl("claude", "sonnet", undefined), true);
});

test("switching models reconciles the effort: kept when valid, default when not, cleared without an axis", () => {
  assert.equal(reconcileReasoningEffort("cursor-sdk", "claude-opus-5-5", "high", live), "high");
  assert.equal(reconcileReasoningEffort("cursor-sdk", "gpt-5.5", "max", live), "xhigh");
  assert.equal(reconcileReasoningEffort("cursor-sdk", "claude-opus-5-5", null, live), "medium");
  assert.equal(reconcileReasoningEffort("cursor-sdk", "default", "high", live), null);
  // other runtimes keep their previous behavior for models without a declared set
  assert.equal(reconcileReasoningEffort("claude", "sonnet", "high", undefined), "high");
});
