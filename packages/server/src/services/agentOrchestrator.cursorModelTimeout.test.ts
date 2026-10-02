import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { MachineToServerMessage, ServerToMachineMessage } from "@botiverse/raft-shared";
import { AgentOrchestrator } from "./agentOrchestrator.js";

afterEach(() => {
  vi.useRealTimers();
});

function setupLocalDetection() {
  const orchestrator = new AgentOrchestrator();
  const connection = {
    ws: { readyState: 1 },
    replicaGeneration: "generation-1",
    connectionEpochId: "epoch-1",
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: "1.0.25",
    computerVersion: "1.0.28",
  };
  const connections = (orchestrator as unknown as {
    machineConnections: Map<string, unknown>;
  }).machineConnections;
  connections.set("machine-1", connection);
  let request: ServerToMachineMessage | undefined;
  (orchestrator as unknown as {
    sendRequiredToMachine: (id: string, message: ServerToMachineMessage) => Promise<void>;
  }).sendRequiredToMachine = async (_id, message) => { request = message; };
  const reply = () => {
    assert.equal(request?.type, "machine:runtime_models:detect");
    if (request?.type !== "machine:runtime_models:detect") assert.fail("missing request");
    orchestrator.emit("machine:response:machine-1", {
      type: "machine:runtime_models:result",
      requestId: request.requestId,
      outcome: { kind: "live", value: { models: [{ id: "auto", label: "Auto" }] } },
    } satisfies MachineToServerMessage);
  };
  return { orchestrator, connection, reply };
}

test("local Cursor discovery accepts a result after the old five-second deadline", async () => {
  vi.useFakeTimers();
  const { orchestrator, reply } = setupLocalDetection();
  const detection = orchestrator.detectMachineRuntimeModels("machine-1", "cursor");
  const result = assert.doesNotReject(async () => {
    assert.deepEqual(await detection, {
      kind: "live", value: { models: [{ id: "auto", label: "Auto" }] },
    });
  });
  await vi.advanceTimersByTimeAsync(6_000);
  reply();
  await result;
  assert.equal(orchestrator.listenerCount("machine:response:machine-1"), 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("Cursor discovery still times out and removes its response listener", async () => {
  vi.useFakeTimers();
  const { orchestrator, reply } = setupLocalDetection();
  const result = assert.rejects(
    orchestrator.detectMachineRuntimeModels("machine-1", "cursor"),
    /Runtime model detect request timed out/,
  );
  await vi.advanceTimersByTimeAsync(25_000);
  await result;
  reply();
  assert.equal(orchestrator.listenerCount("machine:response:machine-1"), 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("slower Cursor discovery still fences results from a replaced connection", async () => {
  vi.useFakeTimers();
  const { orchestrator, connection, reply } = setupLocalDetection();
  const result = assert.rejects(
    orchestrator.detectMachineRuntimeModelsWithAuthority("machine-1", "cursor"),
    /connection changed/i,
  );
  await vi.advanceTimersByTimeAsync(6_000);
  connection.replicaGeneration = "generation-2";
  reply();
  await result;
  assert.equal(orchestrator.listenerCount("machine:response:machine-1"), 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("other runtimes retain their five-second detection deadline", async () => {
  vi.useFakeTimers();
  const { orchestrator } = setupLocalDetection();
  const result = assert.rejects(
    orchestrator.detectMachineRuntimeModels("machine-1", "codex"),
    /Runtime model detect request timed out/,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  await result;
});

test("relayed Cursor discovery accepts a model catalog after six seconds", async () => {
  vi.useFakeTimers();
  const orchestrator = new AgentOrchestrator();
  (orchestrator as unknown as { getMachineResponseRelay: () => unknown }).getMachineResponseRelay = () => ({
    request: (
      input: { requestId: string },
      timeoutMs: number,
    ) => new Promise<MachineToServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay timed out")), timeoutMs);
      setTimeout(() => {
        clearTimeout(timer);
        resolve({
          type: "machine:runtime_models:result",
          requestId: input.requestId,
          outcome: { kind: "live", value: { models: [{ id: "auto", label: "Auto" }] } },
        });
      }, 6_000);
    }),
  });
  const result = assert.doesNotReject(async () => {
    const outcome = await orchestrator.detectMachineRuntimeModels("remote-machine", "cursor");
    assert.equal(outcome.kind, "live");
  });
  await vi.advanceTimersByTimeAsync(6_000);
  await result;
  assert.equal(vi.getTimerCount(), 0);
});

test("a failed detection send cancels the wait and releases timers and listeners", async () => {
  vi.useFakeTimers();
  const { orchestrator } = setupLocalDetection();
  (orchestrator as unknown as {
    sendRequiredToMachine: () => Promise<void>;
  }).sendRequiredToMachine = async () => { throw new Error("connection closed"); };
  await assert.rejects(
    orchestrator.detectMachineRuntimeModels("machine-1", "cursor"),
    /WebSocket not ready/,
  );
  assert.equal(orchestrator.listenerCount("machine:response:machine-1"), 0);
  assert.equal(vi.getTimerCount(), 0);
});
