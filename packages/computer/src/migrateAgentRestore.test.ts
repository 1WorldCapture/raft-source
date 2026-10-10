import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import type { ServerAttachment } from "./serverState.js";
import {
  parseMachineAgents,
  readRunningAgentsRecord,
  recordRunningAgents,
  removeRunningAgentsRecord,
  restoreRecordedAgents,
  writeRunningAgentsRecord,
  type MachineApi,
  type RunningAgentsRecord,
} from "./migrateAgentRestore.js";
import { rewriteCursorCwd } from "./migrateHome.js";

const ATTACHMENT: ServerAttachment = {
  kind: "computer-attachment",
  serverId: "srv-1",
  serverMachineId: "machine-1",
  apiKey: "sk_computer_fixture",
  serverUrl: "https://server.example",
};

function fakeApi(rosterByGet: unknown[][], startStatus = 200): { api: MachineApi; gets: number; starts: string[] } {
  const state = { gets: 0, starts: [] as string[] };
  const api: MachineApi = async (_serverUrl, _apiKey, apiPath, init) => {
    if (apiPath === "/internal/machine/agents") {
      const roster = rosterByGet[Math.min(state.gets, rosterByGet.length - 1)];
      state.gets += 1;
      return { status: 200, json: async () => roster };
    }
    if (init?.method === "POST") {
      state.starts.push(apiPath);
      return { status: startStatus, json: async () => (startStatus === 200 ? { ok: true } : { error: "boom" }) };
    }
    return { status: 404, json: async () => ({ error: "not found" }) };
  };
  return { api, gets: state.gets, starts: state.starts };
}

test("parseMachineAgents skips malformed entries", () => {
  const parsed = parseMachineAgents([
    { id: "a1", status: "active" },
    null,
    "nope",
    { noId: true },
    { id: "", status: "active" },
  ]);
  assert.deepEqual(parsed.map((entry) => entry.id), ["a1"]);
});

test("recordRunningAgents keeps only active agents and reports unreachable servers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "restore-record-"));
  try {
    await mkdir(path.join(root, "computer"), { recursive: true });
    const { api } = fakeApi([
      [
        { id: "a1", name: "one", status: "active", runtime: "claude" },
        { id: "a2", name: "two", status: "inactive", runtime: "claude" },
        { id: "a3", name: "three", status: "stopped", runtime: "claude" },
      ],
    ]);
    const { record, serversUnreachable } = await recordRunningAgents(root, {
      // The "dead" server throws at the transport level — exactly what an
      // unreachable attachment looks like to the real fetch.
      fetchImpl: async (serverUrl, apiKey, apiPath, init) => {
        if (serverUrl.includes("127.0.0.1")) throw new Error("connection refused");
        return api(serverUrl, apiKey, apiPath, init);
      },
      listAttachments: async () => [ATTACHMENT, { ...ATTACHMENT, serverId: "srv-dead", serverUrl: "http://127.0.0.1:1" }],
    });
    assert.deepEqual(record.agents, [
      { agentId: "a1", name: "one", runtime: "claude", serverId: "srv-1" },
    ]);
    assert.deepEqual(serversUnreachable, ["srv-dead"]);
    await writeRunningAgentsRecord(root, record);
    const roundTrip = await readRunningAgentsRecord(root);
    assert.equal(roundTrip?.agents.length, 1);
    await removeRunningAgentsRecord(root);
    assert.equal(await readRunningAgentsRecord(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restoreRecordedAgents starts inactive agents and waits for them to turn active", async () => {
  const { api, starts } = fakeApi([
    [{ id: "a1", status: "inactive" }], // restore lookup
    [{ id: "a1", status: "inactive" }], // poll 1
    [{ id: "a1", status: "active" }], // poll 2 — back
  ]);
  const record: RunningAgentsRecord = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    agents: [{ agentId: "a1", name: "one", runtime: "claude", serverId: "srv-1" }],
  };
  const report = await restoreRecordedAgents("/unused", record, {
    fetchImpl: api,
    listAttachments: async () => [ATTACHMENT],
    sleep: async () => {},
    now: (() => {
      let tick = 0;
      return () => new Date(1_000 + tick++ * 1_000);
    })(),
  });
  assert.deepEqual(report.restored, ["a1"]);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(starts, ["/internal/machine/agents/a1/start"]);
});

test("restoreRecordedAgents leaves already-active agents alone", async () => {
  const { api, starts } = fakeApi([[{ id: "a1", status: "active" }]]);
  const record: RunningAgentsRecord = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    agents: [{ agentId: "a1", name: "one", runtime: "claude", serverId: "srv-1" }],
  };
  const report = await restoreRecordedAgents("/unused", record, {
    fetchImpl: api,
    listAttachments: async () => [ATTACHMENT],
  });
  assert.deepEqual(report.alreadyRunning, ["a1"]);
  assert.deepEqual(report.restored, []);
  assert.deepEqual(starts, []);
});

test("restoreRecordedAgents reports a rejected start and a roster disappearance separately", async () => {
  // a1: server rejects the start. a2: no longer on the machine roster.
  const { api } = fakeApi([[{ id: "a1", status: "inactive" }]], 500);
  const record: RunningAgentsRecord = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    agents: [
      { agentId: "a1", name: "one", runtime: "claude", serverId: "srv-1" },
      { agentId: "a2", name: "two", runtime: "claude", serverId: "srv-1" },
    ],
  };
  const report = await restoreRecordedAgents("/unused", record, {
    fetchImpl: api,
    listAttachments: async () => [ATTACHMENT],
  });
  assert.deepEqual(report.failed.map((entry) => entry.outcome), ["start-failed", "missing-from-roster"]);
});

test("restoreRecordedAgents times out an agent that never turns active", async () => {
  const { api } = fakeApi([[{ id: "a1", status: "inactive" }]]);
  const record: RunningAgentsRecord = {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    agents: [{ agentId: "a1", name: "one", runtime: "claude", serverId: "srv-1" }],
  };
  let tick = 0;
  const report = await restoreRecordedAgents("/unused", record, {
    fetchImpl: api,
    listAttachments: async () => [ATTACHMENT],
    sleep: async () => {},
    now: () => new Date(1_000 + tick++ * 1_000),
    restoreTimeoutMs: 5_000,
    restorePollMs: 1_000,
  });
  assert.deepEqual(report.failed, [
    { agentId: "a1", name: "one", runtime: "claude", serverId: "srv-1", outcome: "not-active-after-timeout", detail: "not active after 5000ms" },
  ]);
});

test("rewriteCursorCwd rewrites only under a source spelling, at a path boundary", () => {
  const from = "/Users/x/.slock-raft";
  const real = "/Users/x/Library/Application Support/app/computer-deployments/home";
  assert.equal(rewriteCursorCwd(`${from}/agents/a1`, [from, real], "/Users/x/.slock"), "/Users/x/.slock/agents/a1");
  assert.equal(rewriteCursorCwd(`${real}/agents/a1`, [from, real], "/Users/x/.slock"), "/Users/x/.slock/agents/a1");
  assert.equal(rewriteCursorCwd(from, [from, real], "/Users/x/.slock"), "/Users/x/.slock");
  // Boundary: a sibling path that merely shares the prefix must not match.
  assert.equal(rewriteCursorCwd(`${from}-neighbor/agents/a1`, [from, real], "/Users/x/.slock"), null);
  assert.equal(rewriteCursorCwd("/Users/other/agents/a1", [from, real], "/Users/x/.slock"), null);
});
