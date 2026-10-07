import assert from "node:assert/strict";
import { test } from "vitest";
import {
  projectExistingAgentRuntimeOptions,
  projectNewAgentRuntimeOptions,
} from "./runtimeAdmissionService.js";

const policy = { grokRuntimeEnabled: false, ompRuntimeEnabled: false };

test("Cursor SDK is selectable only when the Computer reports its SDK assets", () => {
  const installed = projectNewAgentRuntimeOptions(["cursor-sdk"], policy)
    .find((option) => option.runtimeId === "cursor-sdk");
  assert.ok(installed);
  assert.equal(installed.capabilityStatus, "available");
  assert.equal(installed.canSelectInThisContext, true);
  const oldComputer = projectNewAgentRuntimeOptions(["cursor"], policy)
    .find((option) => option.runtimeId === "cursor-sdk");
  assert.ok(oldComputer);
  assert.equal(oldComputer.capabilityStatus, "update_required");
  assert.equal(oldComputer.canSelectInThisContext, false);
});

test("legacy Cursor sessions remain manageable without an implicit SDK migration", () => {
  const options = projectExistingAgentRuntimeOptions(["cursor", "cursor-sdk"], "cursor", policy);
  const legacy = options.find((option) => option.runtimeId === "cursor");
  const sdk = options.find((option) => option.runtimeId === "cursor-sdk");
  assert.equal(legacy?.current, true);
  assert.equal(legacy?.manageableForCurrentAgent, true);
  assert.equal(sdk?.current, false);
  assert.equal(sdk?.availableForNew, true);
});
