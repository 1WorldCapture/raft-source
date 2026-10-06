import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR,
  CursorSdkDriver,
  CursorSdkRuntimeSession,
} from "./cursor-sdk.js";
import { buildCliTransportSystemPrompt } from "./cliTransport.js";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "./types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Cursor Agent",
    displayName: null,
    description: null,
    runtime: "cursor-sdk",
    serverUrl: "https://slock.example",
    authToken: "agent-token",
    sessionId: null,
    model: "default",
    reasoningEffort: null,
    envVars: null,
    runtimeContext: null,
    ...overrides,
  };
}

function makeSpawnContext(overrides: Partial<SpawnContext> = {}): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing instructions" as SpawnContext["standingPrompt"],
    prompt: "wake prompt" as SpawnContext["prompt"],
    workingDirectory: "/tmp/cursor-agent",
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    config: makeConfig(),
    ...overrides,
  };
}

test("session descriptor matches the contract exactly", () => {
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.transport, "child_process");
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.lifecycle, "sdk_session");
  assert.deepEqual(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.input, {
    initial: "request",
    idle: "request",
    busy: "request",
  });
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.readiness, "sdk_ready");
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.turnBoundary, "sdk_event");
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.startPolicy, "immediate");
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.inFlightWake, "steer");
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.busyDelivery, "direct");
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.postTurn, "keep_alive");
  assert.equal(CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR.stdout.channel, "diagnostic");
});

test("driver keeps the legacy persistent/direct/steer surface", () => {
  const driver = new CursorSdkDriver();
  assert.equal(driver.id, "cursor-sdk");
  assert.deepEqual(driver.lifecycle, { kind: "persistent", stdin: "direct", inFlightWake: "steer" });
  assert.deepEqual(driver.communication, { chat: "slock_cli", runtimeControl: "none" });
  assert.deepEqual(driver.session, { recovery: "resume_or_fresh" });
  assert.equal(driver.supportsStdinNotification, true);
  assert.equal(driver.busyDeliveryMode, "direct");
  assert.equal(driver.deliveryOutcomeAttempts, true, "APM attaches attempt watermarks");
  // The standing prompt is mounted as a Cursor project rule on every launch
  // (writeStandingPromptRuleFile), so the APM may use the native
  // standing-prompt startup input on cold starts instead of duplicating the
  // whole prompt as a first user message.
  assert.equal(driver.supportsNativeStandingPrompt, true);
  // Broker detection is verified online against the bound connection.
  assert.equal(driver.model.detectedModelsVerifiedAs, "launchable");
});

test("no vendor CLI print adapter: spawn throws, parseLine is empty, stdin encode is null", async () => {
  const driver = new CursorSdkDriver();
  await assert.rejects(
    () => driver.spawn(makeSpawnContext()),
    /native RuntimeSession/,
  );
  assert.deepEqual(driver.parseLine('{"type":"system"}'), []);
  assert.equal(driver.encodeStdinMessage("hi", "session-1"), null);
  assert.equal(driver.encodeStdinMessage("hi", "session-1", { mode: "busy" }), null);
});

test("buildSystemPrompt uses the registered CLI transport prompt path", () => {
  const driver = new CursorSdkDriver();
  const prompt = driver.buildSystemPrompt(makeConfig(), "agent-1");
  const reference = buildCliTransportSystemPrompt(makeConfig(), { extraCriticalRules: [] });
  assert.equal(prompt, reference);
  assert.ok(typeof prompt === "string" && prompt.length > 0);
});

test("probe returns the injected assets probe verbatim", () => {
  const driver = new CursorSdkDriver({
    probe: () => ({ available: true, version: "1.0.36" }),
  });
  assert.deepEqual(driver.probe(), { available: true, version: "1.0.36" });
});

test("probe without injected assets answers synchronously from the staged assets module", () => {
  const driver = new CursorSdkDriver();
  const first = driver.probe();
  // Static probe (parent wiring): the answer is the real asset state, never
  // an invented pending/available placeholder.
  const second = driver.probe();
  assert.deepEqual(second, first, "probe must be deterministic across calls");
  if (first.available) {
    assert.equal(first.version, "1.0.36", "staged dev assets report the pinned SDK version");
  } else {
    assert.ok(
      typeof first.diagnostic === "string" && first.diagnostic.length > 0,
      "unavailability must carry an actionable diagnostic",
    );
  }
});

test("detectModels delegates to a hermetic broker and preserves an unavailable result", async () => {
  let calls = 0;
  const driver = new CursorSdkDriver({ detectModels: async () => {
    calls += 1;
    return { kind: "error", retryable: true };
  } });
  assert.deepEqual(await driver.detectModels(), { kind: "error", retryable: true });
  assert.equal(calls, 1);
});

test("createSession returns a native session and tracks session identity", () => {
  const driver = new CursorSdkDriver();
  const ctx = makeSpawnContext({ config: makeConfig({ sessionId: "resume-me" }) });
  const session = driver.createSession(ctx);
  assert.ok(session instanceof CursorSdkRuntimeSession);
  assert.equal(session.descriptor, CURSOR_SDK_RUNTIME_SESSION_DESCRIPTOR);
  assert.equal(driver.currentSessionId, "resume-me");
  assert.equal(session.currentSessionId, "resume-me");
  assert.equal(session.isAlive(), undefined, "no pid before start");
});

test("busyDeliveryReadiness delegates to the live session and defaults to ready", () => {
  const driver = new CursorSdkDriver();
  assert.deepEqual(driver.busyDeliveryReadiness(), { ready: true });
  const session = driver.createSession(makeSpawnContext()) as CursorSdkRuntimeSession;
  // Session not ready (not started): must not claim no_active_turn.
  assert.deepEqual(driver.busyDeliveryReadiness(), { ready: true });
  void session;
});
