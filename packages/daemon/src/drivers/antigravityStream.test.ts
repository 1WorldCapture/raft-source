import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import type { AgentConfig } from "@botiverse/raft-shared";
import { getDriver } from "./index.js";
import {
  ANTIGRAVITY_STREAM_DEFAULT_MODEL,
  AntigravityStreamVersionError,
  assertAntigravityStreamLaunchVersion,
  antigravityStreamStopSignal,
  buildAntigravityStreamArgs,
  detectAntigravityStreamModels,
  encodeAntigravityStreamUserMessage,
  parseAntigravityModelList,
  probeAntigravityStream,
} from "./antigravityStream.js";
import { AntigravityStreamEventNormalizer } from "./antigravityStreamEventNormalizer.js";
import type { ParsedEvent } from "./types.js";

const CONVERSATION_ID = "da54c2e7-3036-4220-939d-6386304a8d44";

const baseConfig: AgentConfig = {
  name: "agy-agent",
  displayName: "Agy Agent",
  description: null,
  model: ANTIGRAVITY_STREAM_DEFAULT_MODEL,
  runtime: "antigravity-stream",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "https://raft.example.test",
  authToken: "sk_machine_test",
};

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...baseConfig, ...overrides };
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

function kinds(events: ParsedEvent[]): string[] {
  return events.map((event) => event.kind);
}

function feed(normalizer: AntigravityStreamEventNormalizer, rows: unknown[]): ParsedEvent[] {
  return rows.flatMap((row) => normalizer.normalizeLine(line(row)));
}

function execSpy(replies: Record<string, string | Error>): typeof execFileSync {
  return ((command: string, args?: readonly string[]) => {
    const key = `${command} ${(args ?? []).join(" ")}`;
    const reply = replies[key];
    if (reply === undefined) throw new Error(`unexpected exec: ${key}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof execFileSync;
}

test("launch args pass the model and conversation and omit the forbidden flags", () => {
  const fresh = buildAntigravityStreamArgs(config({ model: "gemini-3.8-flash-low" }));
  assert.deepEqual(fresh, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", "gemini-3.8-flash-low",
    "--dangerously-skip-permissions",
  ]);

  const resumed = buildAntigravityStreamArgs(config({
    model: "default",
    sessionId: CONVERSATION_ID,
  }));
  assert.deepEqual(resumed, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", "gemini-3.8-flash-medium",
    "--dangerously-skip-permissions",
    "--conversation", CONVERSATION_ID,
  ]);

  for (const args of [fresh, resumed]) {
    for (const flag of ["--print", "--effort", "--print-timeout", "--mode", "--sandbox"]) {
      assert.equal(args.includes(flag), false, flag);
    }
  }
});

test("stdin user frames stay a single NDJSON object", () => {
  assert.deepEqual(JSON.parse(encodeAntigravityStreamUserMessage("remember PINECONE")), {
    event: "user",
    message: { content: "remember PINECONE" },
  });
});

test("version 1.1.7 is refused, 1.3.2 is accepted, and a missing binary is unavailable", () => {
  const missing = probeAntigravityStream({
    platform: "darwin",
    env: { PATH: "/tmp/agy-test" },
    execFileSyncFn: execSpy({
      "which agy": new Error("not found"),
    }),
  });
  assert.deepEqual(missing, { available: false });

  const old = probeAntigravityStream({
    platform: "darwin",
    env: { PATH: "/tmp/agy-test" },
    execFileSyncFn: execSpy({
      "which agy": "/tmp/agy-test/agy",
      "/tmp/agy-test/agy --version": "1.1.7\n",
    }),
  });
  assert.equal(old.available, true);
  assert.equal(old.version, "1.1.7");
  assert.throws(
    () => assertAntigravityStreamLaunchVersion(old.version),
    (error: unknown) => {
      assert.ok(error instanceof AntigravityStreamVersionError);
      assert.equal(
        error.message,
        "Antigravity CLI 1.1.7 does not support stream-json (added in 1.1.8). Update agy; 1.3.2 is the version this Raft runtime was tested with.",
      );
      return true;
    },
  );

  const current = probeAntigravityStream({
    platform: "darwin",
    env: { PATH: "/tmp/agy-test" },
    execFileSyncFn: execSpy({
      "which agy": "/tmp/agy-test/agy",
      "/tmp/agy-test/agy --version": "1.3.2\n",
    }),
  });
  assert.equal(current.available, true);
  assert.equal(current.version, "1.3.2");
  assert.doesNotThrow(() => assertAntigravityStreamLaunchVersion(current.version));
  assert.doesNotThrow(() => assertAntigravityStreamLaunchVersion("1.1.8"));
  assert.doesNotThrow(() => assertAntigravityStreamLaunchVersion(null));
});

test("agy models tab output becomes launchable ids and a failed probe invents none", () => {
  assert.deepEqual(parseAntigravityModelList([
    "Fetching models…",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "not-a-row",
    "",
  ].join("\n")), [
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", verified: "launchable" },
  ]);

  const live = detectAntigravityStreamModels({
    platform: "darwin",
    env: { PATH: "/tmp/agy-test" },
    execFileSyncFn: execSpy({
      "which agy": "/tmp/agy-test/agy",
      "/tmp/agy-test/agy models": "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n",
    }),
  });
  assert.equal(live.kind, "live");
  if (live.kind === "live") {
    assert.deepEqual(live.value.models, [
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", verified: "launchable" },
    ]);
  }

  const failed = detectAntigravityStreamModels({
    platform: "darwin",
    env: { PATH: "/tmp/agy-test" },
    execFileSyncFn: execSpy({
      "which agy": "/tmp/agy-test/agy",
      "/tmp/agy-test/agy models": new Error("network"),
    }),
  });
  assert.deepEqual(failed, { kind: "error", retryable: true });
});

test("init, text deltas, and tool ACTIVE/DONE map onto parsed events", () => {
  const normalizer = new AntigravityStreamEventNormalizer();
  const events = feed(normalizer, [
    {
      event: "init",
      conversation_id: CONVERSATION_ID,
      init: { model: "gemini-3.8-flash-low", cwd: "/private/tmp/agy-probe-tom" },
    },
    {
      event: "step_update",
      step_update: { conversation_id: CONVERSATION_ID, state: "DONE", step_type: "user_input" },
    },
    {
      event: "step_update",
      step_update: { conversation_id: CONVERSATION_ID, state: "DONE", step_type: "system_message" },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "PINECONE",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "\n",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "printf hi" } },
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "printf hi" }, output: "hi" },
      },
    },
  ]);

  assert.deepEqual(kinds(events), ["session_init", "text", "text", "tool_call", "tool_output"]);
  assert.equal(events.filter((event) => event.kind === "text").map((event) => event.kind === "text" ? event.text : "").join(""), "PINECONE\n");
  assert.deepEqual(events.find((event) => event.kind === "tool_call"), {
    kind: "tool_call",
    name: "run_command",
    input: { CommandLine: "printf hi" },
  });
  assert.deepEqual(events.find((event) => event.kind === "tool_output"), {
    kind: "tool_output",
    name: "run_command",
    text: "hi",
  });
  assert.equal(normalizer.currentSessionId, CONVERSATION_ID);
});

test("turn telemetry sums step usage and does not add cumulative result usage", () => {
  const normalizer = new AntigravityStreamEventNormalizer();
  const first = feed(normalizer, [
    { event: "init", conversation_id: CONVERSATION_ID },
    {
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_type: "agent_response",
        state: "DONE",
        usage: { input_tokens: 100, output_tokens: 4, thinking_tokens: 258, cache_read_tokens: 0, total_tokens: 362 },
      },
    },
    {
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: "PINECONE\n",
        usage: { input_tokens: 11812, output_tokens: 4, thinking_tokens: 258, cache_read_tokens: 0, total_tokens: 12074 },
      },
    },
  ]);
  const firstUsage = first.find((event) => event.kind === "telemetry");
  assert.equal(firstUsage?.kind, "telemetry");
  if (firstUsage?.kind === "telemetry") {
    assert.equal(firstUsage.usageKind, "per_turn");
    assert.equal(firstUsage.attrs.inputTokens, 100);
    assert.equal(firstUsage.attrs.thinkingTokens, 258);
  }

  const second = feed(normalizer, [
    { event: "step_update", step_update: { conversation_id: CONVERSATION_ID, step_type: "user_input", state: "DONE" } },
    {
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_type: "agent_response",
        state: "DONE",
        usage: { input_tokens: 40, output_tokens: 0, thinking_tokens: 172, cache_read_tokens: 1, total_tokens: 213 },
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_type: "tool",
        state: "DONE",
        tool_name: "run_command",
        tool_info: { output: "hi" },
        usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
      },
    },
    {
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: "hi",
        usage: { input_tokens: 23964, output_tokens: 264, thinking_tokens: 430, cache_read_tokens: 1, total_tokens: 24658 },
      },
    },
  ]);
  const secondUsage = second.find((event) => event.kind === "telemetry");
  assert.equal(secondUsage?.kind, "telemetry");
  if (secondUsage?.kind === "telemetry") {
    assert.deepEqual(secondUsage.attrs, {
      inputTokens: 50,
      outputTokens: 2,
      thinkingTokens: 172,
      cachedInputTokens: 1,
      totalTokens: 225,
    });
  }
  assert.deepEqual(kinds(second), ["tool_output", "telemetry", "turn_end"]);
  assert.equal(second.some((event) => event.kind === "text"), false);
});

test("interrupted result is an error and a turn end, without counting result usage", () => {
  const normalizer = new AntigravityStreamEventNormalizer();
  const events = feed(normalizer, [
    { event: "init", conversation_id: CONVERSATION_ID },
    {
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "ERROR",
        response: "",
        error: "interrupted",
        num_turns: 3,
        usage: { input_tokens: 99999, output_tokens: 1, thinking_tokens: 1, cache_read_tokens: 0, total_tokens: 100001 },
      },
    },
  ]);
  assert.deepEqual(events, [
    { kind: "session_init", sessionId: CONVERSATION_ID },
    { kind: "error", message: "interrupted" },
    { kind: "turn_end", sessionId: CONVERSATION_ID },
  ]);
});

test("stderr print-timeout closes the turn as an error and a later SUCCESS is ignored", () => {
  const normalizer = new AntigravityStreamEventNormalizer();
  normalizer.normalizeLine(line({ event: "init", conversation_id: CONVERSATION_ID }));
  normalizer.normalizeLine(line({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_type: "agent_response",
      state: "DONE",
      usage: { input_tokens: 7, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 7 },
    },
  }));
  const stderr = [
    "Model ID gemini-3.8-flash-low not in local config, defaulting to CCPA",
    "[agy] print timeout after 6s with turn in progress; returning partial output",
  ].join("\n");
  const timeoutEvents = normalizer.noteStderr(stderr);
  assert.deepEqual(timeoutEvents, [
    {
      kind: "telemetry",
      name: "token_usage",
      source: "antigravity_stream_step_usage",
      usageKind: "per_turn",
      sessionId: CONVERSATION_ID,
      attrs: {
        inputTokens: 7,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 7,
      },
    },
    { kind: "error", message: "[agy] print timeout after 6s with turn in progress; returning partial output" },
    { kind: "turn_end", sessionId: CONVERSATION_ID },
  ]);
  assert.deepEqual(normalizer.noteStderr(stderr), []);
  assert.deepEqual(normalizer.normalizeLine(line({
    event: "result",
    result: {
      conversation_id: CONVERSATION_ID,
      status: "SUCCESS",
      response: "",
      usage: { input_tokens: 11812, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 11812 },
    },
  })), []);
});

test("cancel signals SIGINT to the process group and SIGKILL stays a force kill", () => {
  assert.equal(antigravityStreamStopSignal(), "SIGINT");
  assert.equal(antigravityStreamStopSignal("SIGTERM"), "SIGINT");
  assert.equal(antigravityStreamStopSignal("SIGKILL"), "SIGKILL");
});

test("the registered driver queues busy wakes and does not install managed MCP config", () => {
  const driver = getDriver("antigravity-stream");
  assert.equal(driver.id, "antigravity-stream");
  assert.deepEqual(driver.lifecycle, { kind: "persistent", stdin: "direct", inFlightWake: "queue" });
  assert.equal(driver.requiresSessionInitForDelivery, true);
  assert.equal(driver.launchVersionPolicy?.testedGoodVersion, "1.3.2");
  assert.deepEqual(driver.launchVersionPolicy?.knownBadVersions, []);
  if (!driver.model.toLaunchSpec) throw new Error("antigravity-stream must map a model id to launch args");
  assert.deepEqual(driver.model.toLaunchSpec("gemini-3.8-flash-medium"), {
    args: ["--model", "gemini-3.8-flash-medium"],
  });

  const source = readFileSync(new URL("./antigravityStream.ts", import.meta.url), "utf8");
  assert.equal(source.includes("mcp_config.json"), false);
  assert.equal(getDriver("antigravity").id, "antigravity");
});
