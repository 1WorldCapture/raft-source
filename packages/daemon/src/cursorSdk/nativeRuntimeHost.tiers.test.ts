import assert from "node:assert/strict";
import { test } from "vitest";
import type { Run, RunResult, SDKAgent } from "@cursor/sdk";
import { NativeCursorHost } from "./nativeRuntimeHost.js";
import type { SdkModelListItem } from "./modelTiers.js";
import type { CursorSdkHostToDriverMessage, CursorSdkInitMessage } from "./protocol.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const values = (...v: string[]) => v.map((value) => ({ value }));
const MODELS: SdkModelListItem[] = [
  { id: "default", variants: [{ params: [], isDefault: true }] },
  {
    id: "claude-opus-5-5",
    parameters: [
      { id: "effort", values: values("low", "medium", "high", "xhigh", "max") },
      { id: "fast", values: values("false", "true") },
    ],
    variants: [{ params: [{ id: "effort", value: "medium" }, { id: "fast", value: "false" }], isDefault: true }],
  },
  {
    id: "gpt-5.5",
    parameters: [{ id: "reasoning", values: values("none", "low", "medium", "high", "extra-high") }],
    variants: [{ params: [{ id: "reasoning", value: "extra-high" }], isDefault: true }],
  },
];

function init(runOptions: CursorSdkInitMessage["runOptions"], sessionId: string | null = null): CursorSdkInitMessage {
  return {
    kind: "init", protocolVersion: 1, agentId: "raft-test", sessionId,
    workspaceRoot: "/tmp/fixture", hostDataDir: "/tmp/fixture-state", sdkModuleSpecifier: "@cursor/sdk", env: {},
    auth: { apiKey: "fixture-exact-key", backendUrl: "https://api2.cursor.sh", connectionId: "conn", generation: 1, principalId: "42" },
    runOptions,
  };
}

function harness(list?: () => Promise<readonly SdkModelListItem[]>) {
  const messages: CursorSdkHostToDriverMessage[] = [];
  const warnings: string[] = [];
  const seen: { create?: unknown; resume?: unknown; send: unknown[] } = { send: [] };
  const agent = {
    agentId: "agent-fixture", model: { id: "default" },
    async send(_text: string, options: unknown) {
      seen.send.push(options);
      return {
        id: "run-1", agentId: "agent-fixture", status: "running",
        async *stream() { /* no events */ },
        wait: async (): Promise<RunResult> => ({ id: "run-1", status: "finished" }),
        steer: async () => "complete_delivered",
        cancel: async () => undefined,
      } as unknown as Run;
    },
    async [Symbol.asyncDispose]() { /* nothing */ },
  } as unknown as SDKAgent;
  const vendor = {
    Agent: {
      create: async (value: unknown) => { seen.create = value; return agent; },
      resume: async (_id: string, value: unknown) => { seen.resume = value; return agent; },
    },
    JsonlLocalAgentStore: class { constructor(readonly root: string) {} },
    ...(list ? { Cursor: { models: { list } } } : {}),
  };
  const host = new NativeCursorHost({
    loadSdk: async () => vendor as never, env: {}, post: (m) => messages.push(m),
    lock: async () => async () => undefined, shutdownMs: 30, steerTimeoutMs: 30, warn: (m) => warnings.push(m),
  });
  return { host, messages, warnings, seen };
}
const modelOf = (options: unknown) => (options as { model: unknown }).model;

test("create, send and resume all carry the effort and fast params, mapped to the model's own values", async () => {
  const h = harness(async () => MODELS);
  await h.host.receive(init({ model: "claude-opus-5-5", reasoningEffort: "xhigh", fast: true }));
  assert.deepEqual(modelOf(h.seen.create), { id: "claude-opus-5-5", params: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "true" }] });
  await h.host.receive({ kind: "run_submit", runId: "local-1", attemptId: null, text: "hi" });
  await tick();
  assert.deepEqual(modelOf(h.seen.send[0]), { id: "claude-opus-5-5", params: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "true" }] });
  await h.host.stop();

  const r = harness(async () => MODELS);
  await r.host.receive(init({ model: "gpt-5.5", reasoningEffort: "xhigh" }, "agent-fixture"));
  assert.deepEqual(modelOf(r.seen.resume), { id: "gpt-5.5", params: [{ id: "reasoning", value: "extra-high" }] });
  await r.host.stop();
});

test("fast off sends fast=false explicitly for a model that has the param; other models are untouched", async () => {
  const h = harness(async () => MODELS);
  await h.host.receive(init({ model: "claude-opus-5-5" }));
  assert.deepEqual(modelOf(h.seen.create), { id: "claude-opus-5-5", params: [{ id: "fast", value: "false" }] });
  await h.host.stop();
  const g = harness(async () => MODELS);
  await g.host.receive(init({ model: "default" }));
  assert.deepEqual(modelOf(g.seen.create), { id: "default" });
  await g.host.stop();
});

test("lookup failure, missing Cursor surface or unknown model fall back to the bare id with a warning", async () => {
  const failing = harness(async () => { throw new Error("offline"); });
  await failing.host.receive(init({ model: "claude-opus-5-5", reasoningEffort: "high" }));
  assert.deepEqual(modelOf(failing.seen.create), { id: "claude-opus-5-5" });
  assert.ok(failing.warnings.some((w) => /lookup failed/.test(w)));
  await failing.host.stop();

  const bare = harness();
  await bare.host.receive(init({ model: "claude-opus-5-5" }));
  assert.deepEqual(modelOf(bare.seen.create), { id: "claude-opus-5-5" });
  await bare.host.stop();

  const unknown = harness(async () => MODELS);
  await unknown.host.receive(init({ model: "not-a-model", fast: true }));
  assert.deepEqual(modelOf(unknown.seen.create), { id: "not-a-model" });
  assert.ok(unknown.warnings.some((w) => /not in the models list/.test(w)));
  await unknown.host.stop();
});
