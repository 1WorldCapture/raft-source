import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  closeOmpTurnOnProcessExit,
  createOmpEventMappingState,
  mapOmpRpcFrameToParsedEvents,
  ompToolResultText,
} from "./ompEventNormalizer.js";

// fileURLToPath (not .pathname): the checkout path contains spaces, and an
// undecoded pathname (%20) breaks readFileSync.
const FIXTURE_PATH = fileURLToPath(new URL("../testdata/omp-rpc-session.jsonl", import.meta.url));

function readFixtureFrames(): object[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as object);
}

test("the recorded real-session fixture maps to a stable event stream", () => {
  const state = createOmpEventMappingState();
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  for (const frame of readFixtureFrames()) {
    // Ready/response frames are transport-owned (the driver handles them and
    // never forwards them), mirroring parseLine's routing.
    const type = (frame as { type?: string }).type;
    if (type === "ready" || type === "response") continue;
    events.push(...(mapOmpRpcFrameToParsedEvents(frame, state) as Array<{ kind: string; [key: string]: unknown }>));
  }

  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("thinking"), "fixture has thinking deltas");
  assert.ok(kinds.includes("text"), "fixture has text deltas");
  assert.deepEqual(
    kinds.filter((kind) => kind === "tool_call"),
    ["tool_call"],
    "exactly one tool call in the recorded turn",
  );
  assert.deepEqual(
    kinds.filter((kind) => kind === "turn_end"),
    ["turn_end"],
    "exactly one turn_end for the recorded turn",
  );

  const toolOutput = events.find((event) => event.kind === "tool_output") as { text?: string; isError?: boolean };
  assert.ok(toolOutput, "tool_execution_end maps to tool_output");
  assert.match(toolOutput.text ?? "", /quick brown fox/, "tool output carries the read result text");
  assert.equal(toolOutput.isError, undefined);

  const usage = events.find((event) => event.kind === "telemetry") as { name?: string; attrs?: Record<string, number> };
  assert.ok(usage, "message_end usage maps to telemetry");
  assert.equal(usage.name, "token_usage");
  assert.ok((usage.attrs?.totalTokens ?? 0) > 0, "usage carries the recorded totals");

  // Snapshot the full stream for review; regenerate with vitest -u after
  // re-recording the fixture.
  expect(events).toMatchSnapshot();
});

test("prompt_result with sessionSettled=false holds the turn_end for session_settled", () => {
  const state = createOmpEventMappingState();

  const held = mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "p1", agentInvoked: true, status: "completed", sessionSettled: false },
    state,
  );
  assert.deepEqual(held, [], "nothing is emitted while background work may wake the session");

  const settled = mapOmpRpcFrameToParsedEvents({ type: "session_settled" }, state);
  assert.deepEqual(settled.map((event) => event.kind), ["turn_end"]);
});

test("prompt_result with sessionSettled=true closes the turn immediately", () => {
  const state = createOmpEventMappingState();
  const events = mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "p1", agentInvoked: true, status: "completed", sessionSettled: true },
    state,
  );
  assert.deepEqual(events.map((event) => event.kind), ["turn_end"]);

  // A late session_settled must not emit a second turn_end.
  const late = mapOmpRpcFrameToParsedEvents({ type: "session_settled" }, state);
  assert.deepEqual(late, []);
});

test("agentInvoked=false completes locally without turn events", () => {
  const state = createOmpEventMappingState();
  const events = mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "p1", agentInvoked: false, status: "completed", sessionSettled: true },
    state,
  );
  assert.deepEqual(events, []);
});

test("an aborted agent-invoked prompt ends the turn exactly once, error before turn_end", () => {
  const state = createOmpEventMappingState();
  const first = mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "p1", agentInvoked: true, status: "aborted", sessionSettled: true },
    state,
  );
  assert.deepEqual(first.map((event) => event.kind), ["error", "turn_end"]);

  const second = mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "p1", agentInvoked: true, status: "aborted", sessionSettled: true },
    state,
  );
  assert.deepEqual(second, [], "the closed turn must not end twice");
});

test("three consecutive turns each end exactly once on the same state", () => {
  const state = createOmpEventMappingState();
  const runTurn = (id: string): string[] => {
    const kinds: string[] = [];
    kinds.push(...mapOmpRpcFrameToParsedEvents({ type: "agent_start" }, state).map((event) => event.kind));
    kinds.push(...mapOmpRpcFrameToParsedEvents(
      { type: "message_start", message: { role: "assistant", content: [], usage: {}, stopReason: "stop", api: "a", provider: "p", model: "m", timestamp: 0 } },
      state,
    ).map((event) => event.kind));
    kinds.push(...mapOmpRpcFrameToParsedEvents({ type: "agent_end", messages: [], isTerminal: true, yielded: true }, state).map((event) => event.kind));
    kinds.push(...mapOmpRpcFrameToParsedEvents(
      { type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true },
      state,
    ).map((event) => event.kind));
    return kinds;
  };

  assert.deepEqual(runTurn("t1"), ["turn_end"]);
  assert.deepEqual(runTurn("t2"), ["turn_end"], "the second turn must still end");
  assert.deepEqual(runTurn("t3"), ["turn_end"], "the third turn must still end");
});

test("an aborted middle turn does not block later turns", () => {
  const state = createOmpEventMappingState();

  mapOmpRpcFrameToParsedEvents({ type: "agent_start" }, state);
  const aborted = mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "t1", agentInvoked: true, status: "aborted", sessionSettled: true },
    state,
  );
  assert.deepEqual(aborted.map((event) => event.kind), ["error", "turn_end"]);

  mapOmpRpcFrameToParsedEvents({ type: "agent_start" }, state);
  const next = mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "t2", agentInvoked: true, status: "completed", sessionSettled: true },
    state,
  );
  assert.deepEqual(next.map((event) => event.kind), ["turn_end"]);
});

test("a held turn survives a background follow-up run's agent_start", () => {
  const state = createOmpEventMappingState();

  mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "p1", agentInvoked: true, status: "completed", sessionSettled: false },
    state,
  );
  // The background job wakes a follow-up run BEFORE session_settled arrives.
  mapOmpRpcFrameToParsedEvents({ type: "agent_start" }, state);
  mapOmpRpcFrameToParsedEvents({ type: "agent_end", messages: [], isTerminal: true, yielded: true }, state);

  const settled = mapOmpRpcFrameToParsedEvents({ type: "session_settled" }, state);
  assert.deepEqual(settled.map((event) => event.kind), ["turn_end"], "the held turn must still flush exactly once");
});

test("prompt_result error surfaces before the turn_end it closes with", () => {
  const state = createOmpEventMappingState();
  const events = mapOmpRpcFrameToParsedEvents(
    {
      type: "prompt_result",
      id: "p1",
      agentInvoked: true,
      status: "error",
      sessionSettled: true,
      error: { message: "provider exploded", retryable: false },
    },
    state,
  );
  assert.deepEqual(events.map((event) => event.kind), ["error", "turn_end"]);
  assert.equal((events[0] as { message: string }).message, "provider exploded");
});

test("agent_end never closes a turn by itself", () => {
  const state = createOmpEventMappingState();
  for (const extra of [{ isTerminal: true, yielded: true }, { isTerminal: false, awaitingAsyncWork: true }, { yielded: false }]) {
    const events = mapOmpRpcFrameToParsedEvents({ type: "agent_end", messages: [], ...extra }, state);
    assert.deepEqual(events, []);
  }
});

test("process exit with a held turn closes it with an error and exactly one turn_end", () => {
  const state = createOmpEventMappingState();
  mapOmpRpcFrameToParsedEvents(
    { type: "prompt_result", id: "p1", agentInvoked: true, status: "completed", sessionSettled: false },
    state,
  );

  const closure = closeOmpTurnOnProcessExit(state, "exit code 1");
  assert.deepEqual(closure.map((event) => event.kind), ["error", "turn_end"]);

  const again = closeOmpTurnOnProcessExit(state, "exit code 1");
  assert.deepEqual(again, [], "the interrupted turn must not close twice");
});

test("process exit without an open turn is a no-op", () => {
  const state = createOmpEventMappingState();
  assert.deepEqual(closeOmpTurnOnProcessExit(state, "boom"), []);
});

test("auto_retry_end failure surfaces the final error and clears the pending one", () => {
  const state = createOmpEventMappingState();
  mapOmpRpcFrameToParsedEvents(
    { type: "message_end", message: { role: "assistant", usage: {}, stopReason: "error", errorMessage: "provider 500" } },
    state,
  );

  const failure = mapOmpRpcFrameToParsedEvents({ type: "auto_retry_end", success: false, attempt: 2, finalError: "exhausted" }, state);
  assert.deepEqual(failure, [{ kind: "error", message: "exhausted" }]);
  assert.equal(state.pendingProviderError, null);

  mapOmpRpcFrameToParsedEvents(
    { type: "message_end", message: { role: "assistant", usage: {}, stopReason: "error", errorMessage: "provider 500 again" } },
    state,
  );
  const fallback = mapOmpRpcFrameToParsedEvents({ type: "auto_retry_end", success: false, attempt: 3 }, state);
  assert.deepEqual(fallback, [{ kind: "error", message: "provider 500 again" }]);
});

test("a successful retry drops the buffered provider failure", () => {
  const state = createOmpEventMappingState();
  mapOmpRpcFrameToParsedEvents(
    { type: "message_end", message: { role: "assistant", usage: {}, stopReason: "error", errorMessage: "provider 500" } },
    state,
  );
  const recovered = mapOmpRpcFrameToParsedEvents({ type: "auto_retry_end", success: true, attempt: 1 }, state);
  assert.deepEqual(recovered, []);
  assert.equal(state.pendingProviderError, null);
});

test("compaction outcomes map to started/finished/interrupted", () => {
  const state = createOmpEventMappingState();
  assert.deepEqual(
    mapOmpRpcFrameToParsedEvents({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }, state),
    [{ kind: "compaction_started" }],
  );
  assert.deepEqual(
    mapOmpRpcFrameToParsedEvents({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false, result: {} }, state),
    [{ kind: "compaction_finished" }],
  );
  assert.deepEqual(
    mapOmpRpcFrameToParsedEvents({ type: "auto_compaction_end", action: "context-full", aborted: true, willRetry: false, reason: "overflow" }, state),
    [{ kind: "compaction_interrupted", outcome: "aborted", reason: "overflow" }],
  );
  assert.deepEqual(
    mapOmpRpcFrameToParsedEvents({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false, errorMessage: "boom" }, state),
    [{ kind: "compaction_interrupted", outcome: "compaction_failed_or_exhausted", reason: "unknown" }],
  );
});

test("tool result text extraction flattens content blocks and truncates oversize text", () => {
  assert.equal(ompToolResultText(undefined), undefined);
  assert.equal(ompToolResultText("plain"), "plain");
  assert.equal(
    ompToolResultText({ content: [{ type: "text", text: "from content" }, { type: "text", text: " second" }] }),
    "from content\n second",
  );
  const oversize = "x".repeat(ompToolTextLimit() + 10);
  const truncated = ompToolResultText(oversize);
  assert.ok((truncated ?? "").startsWith("x".repeat(100)), "the truncation keeps the head of the text");
  assert.match(truncated ?? "", /\[truncated 10 chars\]$/);
});

function ompToolTextLimit(): number {
  // Kept as a function to avoid importing the constant twice in the assert.
  return 32_000;
}
