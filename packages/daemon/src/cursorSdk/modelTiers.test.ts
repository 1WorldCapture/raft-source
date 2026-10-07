import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildModelSelection, catalogEffortForSdkValue, deriveModelTiers, modelInfoEffortFields,
  type SdkModelListItem,
} from "./modelTiers.js";

// Shapes taken from a real account's models.list (task #7 sample, trimmed).
const values = (...v: string[]) => v.map((value) => ({ value }));
const opus55: SdkModelListItem = {
  id: "claude-opus-5-5",
  parameters: [
    { id: "context", values: values("300k", "1m") },
    { id: "effort", values: values("low", "medium", "high", "xhigh", "max") },
    { id: "fast", values: values("false", "true") },
  ],
  variants: [
    { params: [{ id: "context", value: "1m" }, { id: "effort", value: "medium" }, { id: "fast", value: "false" }], isDefault: true },
    { params: [{ id: "context", value: "300k" }, { id: "effort", value: "low" }, { id: "fast", value: "false" }] },
  ],
};
const gpt55: SdkModelListItem = {
  id: "gpt-5.5",
  parameters: [{ id: "reasoning", values: values("none", "low", "medium", "high", "extra-high") }],
  variants: [{ params: [{ id: "reasoning", value: "extra-high" }], isDefault: true }],
};
const opus5: SdkModelListItem = {
  id: "claude-opus-5",
  parameters: [
    { id: "thinking", values: values("false", "true") },
    { id: "effort", values: values("low", "high") },
  ],
  variants: [{ params: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }], isDefault: true }],
};
const haiku45: SdkModelListItem = {
  id: "claude-haiku-4-5",
  parameters: [{ id: "thinking", values: values("false", "true") }],
  variants: [{ params: [{ id: "thinking", value: "false" }], isDefault: true }],
};
const museSpark: SdkModelListItem = {
  id: "muse-spark-1.3",
  parameters: [{ id: "effort", values: values("minimal", "low", "medium") }],
  variants: [{ params: [{ id: "effort", value: "minimal" }], isDefault: true }],
};
const auto: SdkModelListItem = { id: "default", variants: [{ params: [], isDefault: true }] };

test("effort axis, offered efforts, default and fast come from the model's own parameters", () => {
  const tiers = deriveModelTiers(opus55);
  assert.equal(tiers.effortAxis, "effort");
  assert.deepEqual(tiers.efforts.map((e) => e.effort), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(tiers.defaultEffort, "medium");
  assert.equal(tiers.hasFast, true);
  assert.deepEqual(modelInfoEffortFields(tiers), {
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  });
});

test("axis priority: effort wins over thinking; reasoning is used when it is the only effort-like axis", () => {
  assert.equal(deriveModelTiers(opus5).effortAxis, "effort");
  assert.deepEqual(deriveModelTiers(opus5).efforts.map((e) => e.effort), ["low", "high"]);
  assert.equal(deriveModelTiers(gpt55).effortAxis, "reasoning");
});

test("extra-high is offered as xhigh; none and minimal are not offered", () => {
  assert.equal(catalogEffortForSdkValue("extra-high"), "xhigh");
  assert.equal(catalogEffortForSdkValue("none"), null);
  assert.equal(catalogEffortForSdkValue("minimal"), null);
  const tiers = deriveModelTiers(gpt55);
  assert.deepEqual(tiers.efforts, [
    { effort: "low", sdkValue: "low" }, { effort: "medium", sdkValue: "medium" },
    { effort: "high", sdkValue: "high" }, { effort: "xhigh", sdkValue: "extra-high" },
  ]);
  assert.equal(tiers.defaultEffort, "xhigh");
  assert.deepEqual(deriveModelTiers(museSpark).efforts.map((e) => e.effort), ["low", "medium"]);
  // minimal is the model default but is not offered, so there is no default effort.
  assert.equal(deriveModelTiers(museSpark).defaultEffort, undefined);
});

test("models without an effort axis (thinking-only, auto) offer no efforts and no fast", () => {
  for (const item of [haiku45, auto]) {
    const tiers = deriveModelTiers(item);
    assert.equal(tiers.effortAxis, undefined);
    assert.deepEqual(tiers.efforts, []);
    assert.equal(tiers.hasFast, false);
    assert.deepEqual(modelInfoEffortFields(tiers), {});
  }
});

test("the user's xhigh is sent as the model's own extra-high (round trip)", () => {
  const selection = buildModelSelection("gpt-5.5", deriveModelTiers(gpt55), { reasoningEffort: "xhigh" });
  assert.deepEqual(selection, { id: "gpt-5.5", params: [{ id: "reasoning", value: "extra-high" }] });
});

test("effort and fast become params; fast=false is sent explicitly for models that have the param", () => {
  const tiers = deriveModelTiers(opus55);
  assert.deepEqual(buildModelSelection("claude-opus-5-5", tiers, { reasoningEffort: "high", fast: true }), {
    id: "claude-opus-5-5", params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
  });
  assert.deepEqual(buildModelSelection("claude-opus-5-5", tiers, {}), {
    id: "claude-opus-5-5", params: [{ id: "fast", value: "false" }],
  });
  // context and every other parameter are never sent.
  const sent = buildModelSelection("claude-opus-5-5", tiers, { reasoningEffort: "low", fast: false }).params ?? [];
  assert.deepEqual(sent.map((p) => p.id), ["effort", "fast"]);
});

test("unknown tiers or unsupported requests fall back to the bare model id and warn", () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.deepEqual(buildModelSelection("claude-opus-5-5", null, { reasoningEffort: "high", fast: true }, warn), { id: "claude-opus-5-5" });
  assert.equal(warnings.length, 2);
  // an effort the model does not offer (ultra on opus) is dropped, not sent
  assert.deepEqual(buildModelSelection("claude-opus-5-5", deriveModelTiers(opus55), { reasoningEffort: "ultra" }, warn), {
    id: "claude-opus-5-5", params: [{ id: "fast", value: "false" }],
  });
  // fast requested on a model without the parameter is ignored
  assert.deepEqual(buildModelSelection("claude-haiku-4-5", deriveModelTiers(haiku45), { fast: true }, warn), { id: "claude-haiku-4-5" });
  assert.equal(warnings.length, 4);
  // nothing requested and no tiers: exactly the pre-tiers selection
  assert.deepEqual(buildModelSelection("default", null), { id: "default" });
});
