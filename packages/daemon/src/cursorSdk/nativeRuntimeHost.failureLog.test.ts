import assert from "node:assert/strict";
import { test } from "vitest";
import type { SDKAgent } from "@cursor/sdk";
import { describeSdkError, NativeCursorHost } from "./nativeRuntimeHost.js";
import type { CursorSdkHostToDriverMessage } from "./protocol.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("describeSdkError keeps only name, short code and numeric status — never the message", () => {
  const error = Object.assign(new Error("Bearer sk-secret body={user text}"), { name: "AuthenticationError", status: 401, code: "unauthenticated" });
  const text = describeSdkError(error);
  assert.equal(text, "AuthenticationError code=unauthenticated status=401");
  assert.doesNotMatch(text, /secret|user text/);
  assert.equal(describeSdkError(Object.assign(new Error("x"), { name: "bad name with spaces & secrets", status: 99 })), "Error");
  assert.equal(describeSdkError("sk-secret"), "string");
});

test("a failed send is logged with its class and status, without the message", async () => {
  const messages: CursorSdkHostToDriverMessage[] = [];
  const warnings: string[] = [];
  const agent = {
    agentId: "agent-fixture", model: { id: "default" },
    async send() { throw Object.assign(new Error("key sk-secret rejected"), { name: "AuthenticationError", status: 401 }); },
    async [Symbol.asyncDispose]() { /* nothing */ },
  } as unknown as SDKAgent;
  const host = new NativeCursorHost({
    loadSdk: async () => ({ Agent: { create: async () => agent, resume: async () => agent }, JsonlLocalAgentStore: class { constructor(readonly root: string) {} } }) as never,
    env: {}, post: (m) => messages.push(m), lock: async () => async () => undefined, shutdownMs: 30, steerTimeoutMs: 30, warn: (m) => warnings.push(m),
  });
  await host.receive({
    kind: "init", protocolVersion: 1, agentId: "raft-test", sessionId: null, workspaceRoot: "/tmp/f", hostDataDir: "/tmp/f-state",
    sdkModuleSpecifier: "@cursor/sdk", env: {},
    auth: { apiKey: "sk-secret", backendUrl: "https://api2.cursor.sh", connectionId: "c", generation: 1, principalId: "1" },
    runOptions: { model: "default" },
  } as never);
  await host.receive({ kind: "run_submit", runId: "local-1", attemptId: null, text: "private user text" });
  await tick();
  assert.ok(warnings.includes("cursor-sdk: send failed (AuthenticationError status=401)"), warnings.join("\n"));
  assert.ok(warnings.every((line) => !/secret|private user text/.test(line)));
  await host.stop();
});
