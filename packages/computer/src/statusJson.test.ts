import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeDesiredState } from "./desiredState.js";
import type { ComputerStatusReport, ServerStatusRow } from "./status.js";
import { projectStatusJson } from "./statusJson.js";

function row(overrides: Partial<ServerStatusRow> = {}): ServerStatusRow {
  return {
    serverId: "s1",
    serverSlug: "srv",
    serverMachineId: "m1",
    machineId: "mm1",
    serverUrl: "https://example.test",
    attachedAt: null,
    serverRunnerLogPath: "/tmp/log",
    runnerVersion: { kind: "unobserved" } as never,
    daemon: { running: true, pid: 42 },
    health: "ok",
    serverConnected: true,
    ...overrides,
  };
}

function report(overrides: Partial<ComputerStatusReport> = {}): ComputerStatusReport {
  return {
    slockHome: "/tmp/fake-home",
    loggedIn: true,
    userId: "u1",
    userName: null,
    userDisplayName: null,
    userEmail: null,
    loginServerUrl: "https://example.test",
    userSessionError: null,
    cliVersion: "1.0.29",
    service: { running: true, pid: 7, logPath: "/tmp/svc.log", version: { kind: "observed", version: "1.0.29" } as never },
    upgrade: null,
    hostLifecycle: null,
    servers: [],
    ...overrides,
  };
}

test("projectStatusJson: service projection + desiredState wiring + empty servers", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "status-json-"));
  try {
    await writeDesiredState(home, "stopped");
    const json = await projectStatusJson(report({ slockHome: home }));
    assert.equal(json.home, home);
    assert.equal(json.service.state, "running");
    assert.equal(json.service.pid, 7);
    assert.equal(json.service.version, "1.0.29");
    assert.equal(json.service.desiredState, "stopped");
    assert.equal(json.socket, path.join(home, "computer", "run", "service.sock"));
    assert.deepEqual(json.servers, []);
    assert.equal(json.cursorSdk.installed, false);
    assert.equal(json.migration.state, "none");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("projectStatusJson: stopped service nulls pid; daemon online/starting/offline/failed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "status-json-"));
  try {
    const json = await projectStatusJson(
      report({
        slockHome: home,
        service: { running: false, logPath: "/x", version: { kind: "unobserved" } as never },
        servers: [
          row(),
          row({ serverId: "s2", daemon: { running: true, pid: 8 }, serverConnected: false }),
          row({ serverId: "s3", daemon: { running: false }, health: "offline" }),
          row({ serverId: "s4", daemon: { running: false }, health: "degraded" }),
        ],
      }),
    );
    assert.equal(json.service.state, "stopped");
    assert.equal(json.service.pid, null);
    assert.deepEqual(
      json.servers.map((s) => s.daemonState),
      ["online", "starting", "offline", "failed"],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("projectStatusJson: cursor-sdk manifest and migration result are read from home", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "status-json-"));
  try {
    await mkdir(path.join(home, "runtime", "cursor-sdk"), { recursive: true });
    await writeFile(path.join(home, "runtime", "cursor-sdk", "manifest.json"), '{"version":"0.0.24"}', "utf8");
    await mkdir(path.join(home, "computer"), { recursive: true });
    await writeFile(path.join(home, "computer", "migrate-result.json"), '{"result":"success"}', "utf8");
    const json = await projectStatusJson(report({ slockHome: home }));
    assert.equal(json.cursorSdk.installed, true);
    assert.equal(json.cursorSdk.version, "0.0.24");
    assert.equal(json.migration.state, "done");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
