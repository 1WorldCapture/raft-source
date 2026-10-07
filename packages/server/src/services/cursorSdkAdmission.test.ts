import assert from "node:assert/strict";
import { test } from "vitest";
import { projectNewAgentRuntimeOptions } from "./runtimeAdmissionService.js";

const policy = { grokRuntimeEnabled: false, ompRuntimeEnabled: false };

test("Cursor SDK is selectable only when the Computer reports its SDK assets", () => {
  const installed = projectNewAgentRuntimeOptions(["cursor-sdk"], policy)
    .find((option) => option.runtimeId === "cursor-sdk");
  assert.ok(installed);
  assert.equal(installed.capabilityStatus, "available");
  assert.equal(installed.canSelectInThisContext, true);
  const oldComputer = projectNewAgentRuntimeOptions([], policy)
    .find((option) => option.runtimeId === "cursor-sdk");
  assert.ok(oldComputer);
  assert.equal(oldComputer.capabilityStatus, "update_required");
  assert.equal(oldComputer.canSelectInThisContext, false);
});
