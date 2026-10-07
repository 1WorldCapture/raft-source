import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CURSOR_SDK_HOSTBOUND_QUEUE_MAX,
  CURSOR_SDK_HOST_ENTRY_ENV,
  CURSOR_SDK_HOST_PROTOCOL_VERSION,
  attemptRequestMethod,
  isCursorSdkHostboundMessage,
  isCursorSdkHostToDriverMessage,
  sanitizeCursorSdkWireText,
  toCursorSdkWireError,
} from "./protocol.js";

test("hostbound guard accepts each valid shape and rejects malformed input", () => {
  const init = {
    kind: "init",
    protocolVersion: CURSOR_SDK_HOST_PROTOCOL_VERSION,
    agentId: "agent-1",
    sessionId: null,
    workspaceRoot: "/tmp/w",
    hostDataDir: "/tmp/h",
    auth: null,
    env: {},
    runOptions: {},
    sdkModuleSpecifier: "@cursor/sdk",
  };
  assert.equal(isCursorSdkHostboundMessage(init), true);
  assert.equal(
    isCursorSdkHostboundMessage({ kind: "run_submit", runId: "r1", attemptId: null, text: "hi" }),
    true,
  );
  assert.equal(
    isCursorSdkHostboundMessage({
      kind: "run_submit",
      runId: "r1",
      attemptId: "att-1",
      text: "hi",
    }),
    true,
  );
  assert.equal(
    isCursorSdkHostboundMessage({ kind: "steer_submit", attemptId: "att-2", text: "hi" }),
    true,
  );
  assert.equal(isCursorSdkHostboundMessage({ kind: "stop", reason: "test" }), true);

  assert.equal(isCursorSdkHostboundMessage(null), false);
  assert.equal(isCursorSdkHostboundMessage("init"), false);
  assert.equal(isCursorSdkHostboundMessage({ kind: "init" }), false);
  assert.equal(isCursorSdkHostboundMessage({ kind: "run_submit", runId: "", attemptId: null, text: "x" }), false);
  assert.equal(isCursorSdkHostboundMessage({ kind: "steer_submit", attemptId: 5, text: "x" }), false);
  assert.equal(isCursorSdkHostboundMessage({ kind: "nonsense" }), false);
  assert.equal(isCursorSdkHostboundMessage([1, 2]), false);
});

test("host-to-driver guard accepts valid shapes including null attempt results", () => {
  assert.equal(isCursorSdkHostToDriverMessage({ kind: "host_ready", protocolVersion: 1 }), true);
  assert.equal(
    isCursorSdkHostToDriverMessage({ kind: "init_result", ok: true, sessionId: null }),
    true,
  );
  assert.equal(
    isCursorSdkHostToDriverMessage({
      kind: "init_result",
      ok: false,
      sessionId: null,
      error: { message: "nope", errorClass: "auth" },
    }),
    true,
  );
  assert.equal(
    isCursorSdkHostToDriverMessage({
      kind: "attempt_result",
      attemptId: null,
      result: "revert",
    }),
    true,
  );
  assert.equal(
    isCursorSdkHostToDriverMessage({
      kind: "attempt_result",
      attemptId: "att-1",
      result: "failed",
      error: { message: "boom", errorClass: "host_internal" },
    }),
    true,
  );
  assert.equal(isCursorSdkHostToDriverMessage({ kind: "session_init", sessionId: "s1" }), true);
  assert.equal(
    isCursorSdkHostToDriverMessage({ kind: "run_event", payload: { type: "assistant_text", text: "x" } }),
    true,
  );
  assert.equal(
    isCursorSdkHostToDriverMessage({ kind: "run_settled", runId: "r1", finishReason: "completed" }),
    true,
  );
  assert.equal(
    isCursorSdkHostToDriverMessage({ kind: "host_log", level: "warn", message: "m" }),
    true,
  );
  assert.equal(
    isCursorSdkHostToDriverMessage({ kind: "shutdown_settled", outcome: "deadline" }),
    true,
  );

  assert.equal(isCursorSdkHostToDriverMessage({ kind: "attempt_result", attemptId: "a", result: "nope" }), false);
  assert.equal(isCursorSdkHostToDriverMessage({ kind: "shutdown_settled", outcome: "maybe" }), false);
  assert.equal(isCursorSdkHostToDriverMessage({ kind: "host_log", level: "debug", message: "m" }), false);
  assert.equal(isCursorSdkHostToDriverMessage(undefined), false);
  assert.equal(isCursorSdkHostToDriverMessage({ kind: "run_event", payload: "text" }), false);
});

test("wire sanitizer redacts secret-shaped substrings and never emits stacks", () => {
  const err = new Error("boom sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
  const out = sanitizeCursorSdkWireText(err);
  assert.ok(!out.includes("sk-ABCDEF"), "cursor-style key must be redacted");
  assert.ok(!/\bat \S+\/.+\d:\d/.test(out), "stack frames must not cross the wire");
  assert.ok(out.includes("boom"));
  assert.ok(out.includes("[redacted]"));

  assert.ok(
    !sanitizeCursorSdkWireText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456").includes(
      "abcdefghijklmnop",
    ),
    "bearer tokens must be redacted",
  );
  assert.ok(
    !sanitizeCursorSdkWireText(
      "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N65IjLZqM",
    ).includes("eyJhbGciOiJIUzI1NiIs"),
    "JWTs must be redacted",
  );
});

test("wire sanitizer truncates on a UTF-8 boundary and normalizes whitespace", () => {
  const long = `${"x".repeat(500)}é`;
  const out = sanitizeCursorSdkWireText(long, 100);
  assert.ok(Buffer.byteLength(out, "utf8") <= 140, `expected bounded output, got ${Buffer.byteLength(out)}`);
  assert.ok(out.includes("[truncated"));

  assert.equal(sanitizeCursorSdkWireText("a\u0000b\u0007c"), "a b c");
  assert.equal(sanitizeCursorSdkWireText("   "), "unknown error");
  assert.equal(sanitizeCursorSdkWireText(undefined), "unknown error");
});

test("toCursorSdkWireError sanitizes and classifies", () => {
  const wire = toCursorSdkWireError(new Error("sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ tail"), "busy");
  assert.equal(wire.errorClass, "busy");
  assert.ok(!wire.message.includes("sk-ABCDEF"));
});

test("attempt method labels and constants match the contract", () => {
  assert.equal(attemptRequestMethod("run_submit"), "turn/start");
  assert.equal(attemptRequestMethod("steer_submit"), "turn/steer");
  assert.equal(CURSOR_SDK_HOST_ENTRY_ENV, "RAFT_CURSOR_SDK_HOST_ENTRY");
  assert.ok(CURSOR_SDK_HOSTBOUND_QUEUE_MAX > 0, "outbound queue must be bounded");
});

test("delivery outcome / delivery error event shapes are ParsedEvent-compatible", () => {
  const outcome = {
    kind: "delivery_outcome",
    source: "cursor_sdk",
    attemptId: "att-1",
    outcome: "delivered",
  } as const;
  const failure = {
    kind: "delivery_error",
    message: "agent not found",
    requestMethod: "turn/steer",
    source: "cursor_sdk_response",
    code: "runtime.delivery_error",
  } as const;
  assert.equal(outcome.kind, "delivery_outcome");
  assert.equal(failure.source, "cursor_sdk_response");
  assert.equal(failure.requestMethod, "turn/steer");
});
