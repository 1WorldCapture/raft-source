import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  PROVIDER_PROBE_CAPABILITY,
  type MachineToServerMessage,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { DaemonCore } from "./core.js";
import type { WebSocketLike } from "./connection.js";

const require = createRequire(import.meta.url);
const { evaluateReadyCapabilityContract } = require("../../../scripts/ready-capability-contract.mjs") as {
  evaluateReadyCapabilityContract: (
    repoRoot: string,
    readyCapabilities: string[],
  ) => { gaps: Array<{ name: string }> };
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }

  terminate(): void {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from(""));
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit("open");
    this.emit("message", Buffer.from(JSON.stringify({
      type: "machine:context",
      machineId: "machine-test",
      serverId: "server-test",
    } satisfies ServerToMachineMessage)));
  }
}

async function captureReadyCapabilities(
  options: { computerControlViaSupervisor?: boolean } = {},
): Promise<string[]> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-ready-capability-contract-"));
  const sockets: FakeWebSocket[] = [];
  let core: DaemonCore | null = null;
  try {
    core = new DaemonCore({
      serverUrl: "https://daemon.example.com",
      apiKey: "sk_machine_test",
      dataDir,
      machineStateDir: path.join(dataDir, "machines"),
      runtimeDetector: () => ({ ids: ["builtin"], versions: { builtin: "1.1.0" } }),
      ...(options.computerControlViaSupervisor
        ? { computerControlViaSupervisor: true, onComputerControl: () => {} }
        : {}),
      connectionOptions: {
        wsFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
      },
    });
    core.start();
    const socket = sockets[0];
    assert.ok(socket, "wsFactory should create a websocket");
    socket.emitOpen();
    const ready = socket.sent.find((msg): msg is Extract<MachineToServerMessage, { type: "ready" }> =>
      typeof msg === "object" && msg !== null && (msg as { type?: string }).type === "ready"
    );
    assert.ok(ready?.capabilities, "DaemonCore should send a ready message");
    return [...ready.capabilities];
  } finally {
    if (core) await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("server capability checks are on the ready message DaemonCore sends", async () => {
  const ready = await captureReadyCapabilities();
  const supervisorReady = await captureReadyCapabilities({ computerControlViaSupervisor: true });
  assert.equal(ready.includes(PROVIDER_PROBE_CAPABILITY), true);
  assert.equal(supervisorReady.includes(COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS), true);
  const advertised = [...new Set([...ready, ...supervisorReady])];
  const result = evaluateReadyCapabilityContract(repoRoot, advertised);
  assert.deepEqual(result.gaps, []);
});

test("dropping the probe capability from the captured ready list fails the contract", async () => {
  const ready = await captureReadyCapabilities();
  const withoutProbe = ready.filter((capability) => capability !== PROVIDER_PROBE_CAPABILITY);
  const supervisorReady = await captureReadyCapabilities({ computerControlViaSupervisor: true });
  const advertised = [...new Set([
    ...withoutProbe,
    ...supervisorReady.filter((capability) => capability !== PROVIDER_PROBE_CAPABILITY),
  ])];
  const result = evaluateReadyCapabilityContract(repoRoot, advertised);
  assert.equal(result.gaps.some((gap) => gap.name === "PROVIDER_PROBE_CAPABILITY"), true);
});
