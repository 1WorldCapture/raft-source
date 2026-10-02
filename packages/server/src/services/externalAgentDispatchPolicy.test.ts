import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyDispatchResult } from "./externalAgentDispatchPolicy.js";

test("A27 only exact 200 is accepted; permanent auth/endpoint failures block", () => {
  assert.deepEqual(classifyDispatchResult({ kind: "http", status: 200 }, 1, 0.5), { outcome: "accepted", httpStatus: 200, retryDelayMs: 0 });
  for (const status of [201, 202, 204, 301, 400]) {
    const result = classifyDispatchResult({ kind: "http", status }, 1, 0.5);
    assert.equal(result.outcome, "rejected"); assert.equal(result.errorCode, "provider_protocol_mismatch");
  }
  for (const status of [401, 403, 404, 410]) assert.ok(classifyDispatchResult({ kind: "http", status }, 1, 0.5).blockReason);
});
test("A27 exponential jitter and Retry-After are bounded, including hostile values", () => {
  assert.equal(classifyDispatchResult({ kind: "http", status: 500 }, 1, 0).retryDelayMs, 500);
  assert.equal(classifyDispatchResult({ kind: "http", status: 500 }, 2, 1).retryDelayMs, 3000);
  assert.equal(classifyDispatchResult({ kind: "http", status: 429, retryAfterMs: 1e20 }, 100, 1).retryDelayMs, 300000);
  assert.equal(classifyDispatchResult({ kind: "http", status: 429, retryAfterMs: 5000 }, 1, 0).retryDelayMs, 5000);
  assert.equal(classifyDispatchResult({ kind: "http", status: 429, retryAfterMs: 1500.5 }, 1, 0).retryDelayMs, 1501);
  for (const retryAfterMs of [-1, Infinity, NaN]) assert.equal(classifyDispatchResult({ kind: "http", status: 429, retryAfterMs }, 1, 0.5).errorCode, "adapter_failure");
});
test("A32 malformed provider text cannot enter audit; unknown never proves execution", () => {
  const result = classifyDispatchResult({ kind: "unknown", reason: "secret-in-provider-error" }, 1, 0.5);
  assert.deepEqual(result, { outcome: "unknown", errorCode: "adapter_failure", retryDelayMs: 1000 });
  assert.equal(classifyDispatchResult({ kind: "http", status: 200, body: "private input" }, 1, 0.5).outcome, "unknown");
  assert.throws(() => classifyDispatchResult({}, 0, 0.5));
  assert.throws(() => classifyDispatchResult({}, 1, NaN));
});
