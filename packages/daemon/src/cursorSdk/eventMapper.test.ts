import assert from "node:assert/strict";
import { test } from "vitest";
import {
  announceCursorSdkSessionInit,
  createCursorSdkEventMappingState,
  mapCursorSdkRunEventPayload,
  mapCursorSdkRunEventWirePayload,
} from "./eventMapper.js";

test("current SDK user echo never becomes another user message or any parsed event", () => {
  const state = createCursorSdkEventMappingState("s1");
  const events = mapCursorSdkRunEventPayload(
    { type: "user_echo", payloadBytes: 42 },
    state,
  );
  assert.deepEqual(events, []);
  // And the defensive wire variant agrees.
  assert.deepEqual(mapCursorSdkRunEventWirePayload({ type: "user_echo", payloadBytes: 42 }, state), []);
});

test("assistant content maps to text and thinking events", () => {
  const state = createCursorSdkEventMappingState("s1");
  assert.deepEqual(mapCursorSdkRunEventPayload({ type: "assistant_text", text: "hello" }, state), [
    { kind: "text", text: "hello" },
  ]);
  assert.deepEqual(
    mapCursorSdkRunEventPayload({ type: "assistant_thinking", text: "hm" }, state),
    [{ kind: "thinking", text: "hm" }],
  );
  assert.deepEqual(mapCursorSdkRunEventPayload({ type: "assistant_text", text: "" }, state), []);
});

test("tool events map with bounded name fallbacks", () => {
  const state = createCursorSdkEventMappingState("s1");
  assert.deepEqual(
    mapCursorSdkRunEventPayload({ type: "tool_call", name: "bash", input: { cmd: "ls" } }, state),
    [{ kind: "tool_call", name: "bash", input: { cmd: "ls" } }],
  );
  assert.deepEqual(
    mapCursorSdkRunEventPayload({ type: "tool_call", name: "", input: undefined }, state),
    [{ kind: "tool_call", name: "unknown_tool", input: {} }],
  );
  assert.deepEqual(mapCursorSdkRunEventPayload({ type: "tool_result", name: "bash" }, state), [
    { kind: "tool_output", name: "bash" },
  ]);
});

test("usage maps to a telemetry sidecar with a whitelist and session id", () => {
  const state = createCursorSdkEventMappingState("session-9");
  const events = mapCursorSdkRunEventPayload(
    {
      type: "usage",
      attrs: { input_tokens: 10, output_tokens: 5, evil_payload: "x".repeat(200), ok_flag: true },
      usageKind: "per_turn",
    },
    state,
  );
  assert.equal(events.length, 1);
  const event = events[0] as { kind: string; name: string; attrs: Record<string, unknown> };
  assert.equal(event.kind, "telemetry");
  assert.equal(event.name, "token_usage");
  assert.equal(event.attrs["input_tokens"], 10);
  assert.equal(event.attrs["output_tokens"], 5);
  assert.equal("evil_payload" in event.attrs, false, "non-whitelisted attrs must not cross");

  const empty = mapCursorSdkRunEventPayload({ type: "usage", attrs: { nope: 1 } }, state);
  assert.deepEqual(empty, [], "usage with no whitelisted keys emits nothing");
});

test("diagnostics never map to APM state (dropped; surfaced via stderr by the session)", () => {
  const state = createCursorSdkEventMappingState();
  assert.deepEqual(mapCursorSdkRunEventPayload({ type: "diagnostic", message: "note" }, state), []);
  assert.deepEqual(mapCursorSdkRunEventWirePayload({ type: "diagnostic", message: "note" }, state), []);
});

test("session_init is announced once per id and re-announced on rollover", () => {
  const state = createCursorSdkEventMappingState(null);
  const first = announceCursorSdkSessionInit(state, "s1");
  assert.deepEqual(first, [{ kind: "session_init", sessionId: "s1" }]);
  assert.deepEqual(announceCursorSdkSessionInit(state, "s1"), [], "same id must not re-announce");
  const rollover = announceCursorSdkSessionInit(state, "s2");
  assert.deepEqual(rollover, [{ kind: "session_init", sessionId: "s2" }]);
});

test("defensive wire mapper drops malformed payloads without throwing", () => {
  const state = createCursorSdkEventMappingState("s1");
  assert.deepEqual(mapCursorSdkRunEventWirePayload(null, state), []);
  assert.deepEqual(mapCursorSdkRunEventWirePayload("text", state), []);
  assert.deepEqual(mapCursorSdkRunEventWirePayload({ type: "assistant_text", text: 42 }, state), []);
  assert.deepEqual(mapCursorSdkRunEventWirePayload({ type: "unknown_thing", x: 1 }, state), []);
  assert.deepEqual(
    mapCursorSdkRunEventWirePayload({ type: "usage", attrs: "nope" }, state),
    [],
  );
});
