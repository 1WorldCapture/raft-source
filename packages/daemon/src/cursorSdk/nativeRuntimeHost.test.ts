import assert from "node:assert/strict";
import { test } from "vitest";
import type { Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk";
import { NativeCursorHost, nativeMessagePayloads } from "./nativeRuntimeHost.js";
import type { CursorSdkHostToDriverMessage, CursorSdkInitMessage } from "./protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const input: CursorSdkInitMessage = {
  kind: "init", protocolVersion: 1, agentId: "raft-test", sessionId: null,
  workspaceRoot: "/tmp/fixture", hostDataDir: "/tmp/fixture-state", sdkModuleSpecifier: "@cursor/sdk",
  env: { CURSOR_API_KEY: "malicious-override", NODE_OPTIONS: "--require bad", TEAM_FLAG: "ok" },
  auth: { apiKey: "fixture-exact-key", backendUrl: "https://api2.cursor.sh", connectionId: "conn", generation: 1, principalId: "42" },
  runOptions: { model: "default" },
};

function harness() {
  const messages: CursorSdkHostToDriverMessage[] = [];
  const waits: ReturnType<typeof deferred<RunResult>>[] = [];
  const acks: ReturnType<typeof deferred<"complete_delivered" | "revert_to_followup">>[] = [];
  const calls: string[] = [];
  const env: NodeJS.ProcessEnv = { CURSOR_API_KEY: "ambient", NODE_OPTIONS: "ambient" };
  let options: unknown;
  const agent = {
    agentId: "agent-fixture", model: { id: "default" },
    async send(text: string) {
      calls.push(`send:${text}`);
      const wait = deferred<RunResult>(); waits.push(wait);
      const ack = deferred<"complete_delivered" | "revert_to_followup">(); acks.push(ack);
      return {
        id: `run-${waits.length}`, agentId: "agent-fixture", status: "running",
        async *stream() {
          yield { type: "assistant", agent_id: "agent-fixture", run_id: "run-fixture", message: { role: "assistant", content: [{ type: "text", text: "line one\nline two" }] } } satisfies SDKMessage;
        },
        wait: () => wait.promise,
        steer: (value: string) => { calls.push(`steer:${value}`); return ack.promise; },
        cancel: async () => { wait.resolve({ id: "run-fixture", status: "cancelled" }); },
      } as Run;
    },
    async [Symbol.asyncDispose]() { calls.push("dispose"); },
  } as SDKAgent;
  const vendor = {
    Agent: {
      create: async (value: unknown) => { options = value; calls.push("create"); return agent; },
      resume: async (_id: string, value: unknown) => { options = value; calls.push("resume"); return agent; },
    },
    JsonlLocalAgentStore: class { constructor(readonly root: string) {} },
  } as unknown as Pick<typeof import("@cursor/sdk"), "Agent" | "JsonlLocalAgentStore">;
  const host = new NativeCursorHost({ loadSdk: async () => vendor, env, post: (m) => messages.push(m), lock: async () => async () => { calls.push("unlock"); }, shutdownMs: 30, steerTimeoutMs: 30 });
  return { host, messages, waits, acks, calls, env, options: () => options as { apiKey: string; local: { settingSources: string[] } } };
}

test("native adapter calls exact public Agent.create API and keeps the explicit key out of environment", async () => {
  const h = harness();
  await h.host.receive(input);
  assert.equal(h.options().apiKey, "fixture-exact-key");
  assert.equal(h.env.CURSOR_API_KEY, undefined);
  assert.equal(h.env.NODE_OPTIONS, undefined);
  assert.equal(h.env.TEAM_FLAG, "ok");
  assert.ok(h.options().local.settingSources.includes("mdm"));
  assert.equal(h.messages[0].kind, "init_result");
  assert.equal(JSON.stringify(h.messages).includes("fixture-exact-key"), false);
  await h.host.stop();
});

test("same SDKAgent serves two sequential Runs and ignores stream completion before native terminal", async () => {
  const h = harness(); await h.host.receive(input);
  await h.host.receive({ kind: "run_submit", runId: "local-1", attemptId: "d1", text: "first" });
  await tick();
  assert.equal(h.messages.some((m) => m.kind === "run_settled"), false);
  h.waits[0].resolve({ id: "run-1", status: "finished" }); await tick();
  await h.host.receive({ kind: "run_submit", runId: "local-2", attemptId: "d2", text: "second" }); await tick();
  h.waits[1].resolve({ id: "run-2", status: "finished" }); await tick();
  assert.equal(h.calls.filter((c) => c === "create").length, 1);
  assert.equal(h.messages.filter((m) => m.kind === "run_settled").length, 2);
  assert.deepEqual(h.calls.filter((c) => c.startsWith("send:")), ["send:first", "send:second"]);
  const text = h.messages.find((m) => m.kind === "run_event" && m.payload.type === "assistant_text");
  assert.equal(text?.kind === "run_event" && text.payload.type === "assistant_text" ? text.payload.text : null, "line one\nline two");
  await h.host.stop();
});

test("steer ACK gates terminal emission; revert never creates an adapter-owned follow-up", async () => {
  const h = harness(); await h.host.receive(input);
  await h.host.receive({ kind: "run_submit", runId: "local-1", attemptId: null, text: "first" }); await tick();
  const steering = h.host.receive({ kind: "steer_submit", attemptId: "d1", text: "change" });
  h.waits[0].resolve({ id: "run-1", status: "finished" }); await tick();
  assert.equal(h.messages.some((m) => m.kind === "run_settled"), false);
  h.acks[0].resolve("revert_to_followup"); await steering; await tick();
  assert.ok(h.messages.some((m) => m.kind === "attempt_result" && m.attemptId === "d1" && m.result === "revert"));
  assert.equal(h.calls.filter((c) => c.startsWith("send:")).length, 1);
  assert.equal(h.messages.filter((m) => m.kind === "run_settled").length, 1);
  await h.host.stop();
});

test("SDK user echo and finished status do not become input or terminal; tool completion is not a second start", () => {
  const base = { agent_id: "agent-a", run_id: "run-a" };
  assert.deepEqual(nativeMessagePayloads({ ...base, type: "user", message: { role: "user", content: [] } }), []);
  assert.deepEqual(nativeMessagePayloads({ ...base, type: "status", status: "FINISHED" }), []);
  assert.deepEqual(nativeMessagePayloads({ ...base, type: "tool_call", call_id: "c", name: "read", status: "completed" }), [{ type: "tool_result", name: "read" }]);
});
