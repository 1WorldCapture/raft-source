import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { CURSOR_SDK_HOST_ENTRY_ENV, __internals } from "./runtimeHost.js";

const {
  normalizeCursorSdkStreamMessage,
  agentIdOfSystemMessage,
  classifyCursorSdkError,
  describeSdkModuleSurface,
  acquireHostLock,
} = __internals;

test("importing the host module does not start the host loop", () => {
  // The test process is alive with no host main loop running: if the entry
  // guard were missing, main() would have killed this process at import.
  assert.equal(process.exitCode, undefined);
  assert.equal(CURSOR_SDK_HOST_ENTRY_ENV, "RAFT_CURSOR_SDK_HOST_ENTRY");
});

test("UnknownAgentError classifies as busy-semantics, never as not-found", () => {
  // The SDK's own docblock: UnknownAgentError is "not a missing-agent
  // signal" — the generic/unclassified (and busy-steering) bucket.
  const named = new Error("steering could not be applied");
  named.name = "UnknownAgentError";
  assert.equal(classifyCursorSdkError(named), "unknown_agent");
  assert.equal(
    classifyCursorSdkError(new Error("UnknownAgentError: could not steer")),
    "unknown_agent",
  );
  const notFound = new Error("no such agent");
  notFound.name = "AgentNotFoundError";
  assert.equal(classifyCursorSdkError(notFound), "agent_not_found");
  assert.equal(classifyCursorSdkError(new Error("AgentNotFoundError: gone")), "agent_not_found");
  // Order matters: AgentNotFoundError wins even if the text mentions both.
  const both = new Error("AgentNotFoundError after UnknownAgentError retry");
  assert.equal(classifyCursorSdkError(both), "agent_not_found");

  const busy = new Error("conflict");
  busy.name = "AgentBusyError";
  assert.equal(classifyCursorSdkError(busy), "busy");
  const auth = new Error("401");
  auth.name = "AuthenticationError";
  assert.equal(classifyCursorSdkError(auth), "auth");
  assert.equal(classifyCursorSdkError("string error"), "host_internal");
});

test("stream normalizer converts real SDKMessage shapes to protocol payloads", () => {
  // user echo: message.content blocks → dropped-side user_echo with bytes
  const echo = normalizeCursorSdkStreamMessage({
    type: "user",
    agent_id: "a1",
    run_id: "r1",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
  // payloadBytes measures the serialized content array (bounded wire evidence)
  assert.deepEqual(echo, [{ type: "user_echo", payloadBytes: 32 }]);

  // assistant: content blocks split into text and tool_use payloads
  const assistant = normalizeCursorSdkStreamMessage({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "spoken" },
        { type: "tool_use", id: "tu1", name: "shell", input: { command: "ls" } },
      ],
    },
  });
  assert.deepEqual(assistant, [
    { type: "assistant_text", text: "spoken" },
    { type: "tool_call", name: "shell", input: { command: "ls" } },
  ]);

  // tool_call lifecycle: running → tool_call, completed → tool_result
  const started = normalizeCursorSdkStreamMessage({
    type: "tool_call",
    call_id: "c1",
    name: "read",
    status: "running",
    args: { path: "/tmp" },
  });
  assert.deepEqual(started, [{ type: "tool_call", name: "read", input: { path: "/tmp" } }]);
  const finished = normalizeCursorSdkStreamMessage({
    type: "tool_call",
    call_id: "c1",
    name: "read",
    status: "completed",
    result: "file body",
  });
  assert.equal(finished.length, 1);
  assert.equal(finished[0].type, "tool_result");

  // thinking: plain text field
  const thinking = normalizeCursorSdkStreamMessage({ type: "thinking", text: "pondering" });
  assert.deepEqual(thinking, [{ type: "assistant_thinking", text: "pondering" }]);

  // usage: TokenUsage camelCase → whitelisted snake_case attrs, per turn
  const usage = normalizeCursorSdkStreamMessage({
    type: "usage",
    usage: {
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
      totalTokens: 18,
      reasoningTokens: 1,
    },
  });
  assert.deepEqual(usage, [
    {
      type: "usage",
      attrs: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 6,
        total_tokens: 18,
        reasoning_tokens: 1,
      },
      usageKind: "per_turn",
    },
  ]);

  // unknown shape: bounded diagnostic with the type NAME only
  const unknown = normalizeCursorSdkStreamMessage({ type: "exotic_new_thing", payload: "secret" });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].type, "diagnostic");
  assert.ok(unknown[0].message.includes("exotic_new_thing"));
  assert.ok(!unknown[0].message.includes("secret"), "raw payload must not cross");
});

test("system message identity extraction for native resume", () => {
  assert.equal(
    agentIdOfSystemMessage({ type: "system", subtype: "init", agent_id: "agent-xyz", run_id: "r" }),
    "agent-xyz",
  );
  assert.equal(agentIdOfSystemMessage({ type: "assistant" }), null);
  assert.equal(agentIdOfSystemMessage({ type: "system", agent_id: "" }), null);
});

test("sdk module surface validation matches the pinned Agent factory", () => {
  const fakeAgent = () => ({ send: async () => ({}) });
  const real = {
    Agent: {
      create: async () => fakeAgent(),
      resume: async () => fakeAgent(),
    },
  };
  assert.deepEqual(describeSdkModuleSurface(real), { usable: true, missing: [] });

  const noResume = { Agent: { create: async () => fakeAgent() } };
  assert.deepEqual(describeSdkModuleSurface(noResume), { usable: false, missing: ["Agent.resume"] });

  assert.deepEqual(describeSdkModuleSurface({}), { usable: false, missing: ["Agent"] });

  // The real export is a CLASS with static create/resume (typeof "function").
  class RealShapeAgent {
    static async create() {
      return fakeAgent();
    }
    static async resume() {
      return fakeAgent();
    }
  }
  assert.deepEqual(
    describeSdkModuleSurface({ Agent: RealShapeAgent as never }),
    { usable: true, missing: [] },
  );
  const functionShapedResume = { Agent: { create: async () => fakeAgent(), resume: "not-a-fn" } };
  assert.deepEqual(describeSdkModuleSurface(functionShapedResume as never), {
    usable: false,
    missing: ["Agent.resume"],
  });
  assert.deepEqual(
    describeSdkModuleSurface(null as unknown as Parameters<typeof describeSdkModuleSurface>[0]),
    { usable: false, missing: ["module"] },
  );
});

test("single-writer lock: acquires, refuses live owners, reclaims stale ones", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-sdk-host-test-"));
  try {
    const lock = acquireHostLock(dir, "boot-1");
    assert.ok(existsSync(lock.path));
    const pidLine = readFileSync(lock.path, "utf8").split("\n")[0];
    assert.equal(Number.parseInt(pidLine, 10), process.pid);

    // Live owner (this process) → fail closed with a typed error.
    assert.throws(
      () => acquireHostLock(dir, "boot-2"),
      (error: unknown) => {
        assert.match((error as { message: string }).message, /live process/);
        return (error as { errorClass?: string }).errorClass === "host_lock";
      },
    );

    // Release, then acquire again.
    lock.release();
    assert.equal(existsSync(lock.path), false);
    const lock2 = acquireHostLock(dir, "boot-3");
    lock2.release();

    // Stale owner (pid that cannot exist) → reclaimed transparently.
    writeFileSync(path.join(dir, "host.lock"), "999999999\nboot-dead\n", { mode: 0o600 });
    const lock3 = acquireHostLock(dir, "boot-4");
    lock3.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
