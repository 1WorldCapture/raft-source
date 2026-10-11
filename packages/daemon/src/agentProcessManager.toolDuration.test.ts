// Formatting contract for the tool-finished activity detail.
//
// The pi SDK (>= 1.1.0) reports the monotonic wall time of each tool run via
// `tool_execution_end.durationMs`; agentProcessManager renders it into the
// activity feed. These tests pin the formatting so the feed stays stable
// across locales/environments (pure function, no APM state needed).

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { formatToolFinishedDetail } from "./agentProcessManager.js";

describe("formatToolFinishedDetail", () => {
  test("keeps the bare label when duration is unknown or invalid", () => {
    assert.equal(formatToolFinishedDetail(undefined), "Tool finished");
    assert.equal(formatToolFinishedDetail(Number.NaN), "Tool finished");
    assert.equal(formatToolFinishedDetail(-1), "Tool finished");
  });

  test("renders sub-10s runs with one decimal", () => {
    assert.equal(formatToolFinishedDetail(0), "Tool finished (0.0s)");
    assert.equal(formatToolFinishedDetail(1234), "Tool finished (1.2s)");
    assert.equal(formatToolFinishedDetail(9494), "Tool finished (9.5s)");
  });

  test("renders >=10s runs without decimals and minutes past a minute", () => {
    assert.equal(formatToolFinishedDetail(10_000), "Tool finished (10s)");
    assert.equal(formatToolFinishedDetail(59_000), "Tool finished (59s)");
    assert.equal(formatToolFinishedDetail(61_000), "Tool finished (1m 1s)");
    assert.equal(formatToolFinishedDetail(125_000), "Tool finished (2m 5s)");
    assert.equal(formatToolFinishedDetail(95_000), "Tool finished (1m 35s)");
  });
});
