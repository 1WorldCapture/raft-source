import assert from "node:assert/strict";
import { test } from "vitest";
import { RUNTIMES } from "@botiverse/raft-shared";
import { getDriver, isRetiredRuntime, RetiredRuntimeError } from "./index.js";

test("the retired Cursor CLI runtime gives an explicit 'no longer available' error, not 'Unknown runtime'", () => {
  assert.equal(isRetiredRuntime("cursor"), true);
  assert.equal(isRetiredRuntime("cursor-sdk"), false);
  assert.throws(() => getDriver("cursor"), (error: unknown) => {
    assert.ok(error instanceof RetiredRuntimeError);
    assert.equal(error.runtimeId, "cursor");
    assert.match(error.message, /no longer available/);
    assert.match(error.message, /cursor-sdk/);
    assert.doesNotMatch(error.message, /Unknown runtime/);
    return true;
  });
});

test("truly unknown runtimes still report Unknown runtime, and the Cursor SDK driver is intact", () => {
  assert.throws(() => getDriver("definitely-not-a-runtime"), /Unknown runtime: definitely-not-a-runtime/);
  assert.equal(getDriver("cursor-sdk").id, "cursor-sdk");
  assert.equal(RUNTIMES.some((runtime) => runtime.id === "cursor"), false);
});
