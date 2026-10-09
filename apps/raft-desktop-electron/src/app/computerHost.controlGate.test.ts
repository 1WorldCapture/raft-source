// While the one-click migration applies, the embedded host refuses every control operation from ANY caller
// (not only IPC); quit attempts are never gated; lifting the gate restores normal behaviour.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("control gate refuses start/stop/restart/recycle/converge while set, never gates quit attempts", async (t) => {
  const testHome = await mkdtemp(path.join(tmpdir(), "raft-host-gate-"));
  t.after(() => rm(testHome, { recursive: true, force: true }));
  const calls: string[] = [];
  const api = {
    getStatus: async () => ({ servers: [{ serverId: "s1" }], service: { running: false } }),
    stop: async () => { calls.push("stop"); },
    start: async () => { calls.push("start"); },
    attach: async () => ({ serverId: "s1", apiKey: "k" }),
    resetService: async () => {},
    tryUpgradeViaService: async () => ({ routed: false }),
  };
  t.mock.module("electron", { namedExports: {
    app: {
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: () => {},
      getPath: () => testHome,
    },
  } });
  t.mock.module("./sessionOriginGuard.js", { namedExports: {
    checkSessionOrigin: async () => ({ status: "none", configuredOrigin: "https://example.invalid" }),
    describeSessionOriginMismatch: () => "",
    SESSION_ORIGIN_MISMATCH_CODE: "SESSION_ORIGIN_MISMATCH",
  } });
  t.mock.module("@botiverse/raft-computer/lib", { namedExports: {
    connectService: async () => { throw new Error("unused"); },
    convergeAppHostLifecycle: async () => ({ owner: "app", enabled: true, status: "converged", label: null, definitionPath: null, definition: null }),
    createComputerApi: () => api,
    readProcessStartTime: async () => null,
    rebindParentEvidence: async () => {},
    DEFAULT_UPGRADE_BASE_URL: "https://example.invalid/computer",
    // phase 3-1: the host archives foreign-origin attachments before attach.
    listServerAttachments: async () => [],
    serversDir: (home: string) => `${home}/computer/servers`,
    canonicalizeServerUrl: (url: string) => { try { return new URL(url).origin; } catch { return url; } },
    fetchCdnLatestVersion: async () => null,
    resolveRaftHome: () => testHome,
    userSessionPath: (home: string) => `${home}/user-session.json`,
  } });

  const { ComputerHost } = await import("./computerHost.ts");
  const host = new ComputerHost({ home: testHome, configuredOrigin: "http://example.invalid", readProcesses: async () => ({ rootPids: [], rows: [] }) });

  let locked = true;
  host.setControlGate(() => (locked ? "being moved" : null));
  for (const op of [() => host.start(), () => host.stop(), () => host.restart(), () => host.recycleService(), () => host.converge(), () => host.retryConverge()]) {
    await assert.rejects(op, /being moved/);
  }
  assert.deepEqual(calls, [], "nothing reached the Computer API");
  assert.equal(await host.runQuitAttempt(async () => true), true, "quit is never gated");
  assert.ok(await host.getStatus(), "read-only status keeps working");

  locked = false;
  await host.start();
  assert.deepEqual(calls, ["start"]);
});
