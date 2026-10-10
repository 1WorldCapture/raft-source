// An orphaned runner (its service died with the app) must be swept before a new service is started over it:
// otherwise the new service never gets a runner of its own and never reconnects. Both Start and the launch converge.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";


const row = (pid: number, command: string, ppid = 1) => ({ pid, ppid, pgid: pid, lstart: "Fri Oct 9 21:07:54 2026", command, agent: false, root: true });

test("orphaned runners are swept before a service is started (Start and launch converge); a live service or an empty home is left alone", async (t) => {
  const testHome = await mkdtemp(path.join(tmpdir(), "raft-host-orphan-"));
  t.after(() => rm(testHome, { recursive: true, force: true }));
  // One mock set for the whole file (module cache): the scenario is driven through these mutable variables.
  let calls: string[] = [];
  let signals: Array<[number, string]> = [];
  let rows: Array<ReturnType<typeof row> & { home: string }> = [];
  let rootPids: number[] = [];
  const setRows = (list: Array<ReturnType<typeof row>>, roots: number[]) => { rows = list.map((r) => ({ ...r, home: testHome })); rootPids = roots; calls = []; signals = []; };
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
  const host = new ComputerHost({
    home: testHome, configuredOrigin: "http://example.invalid",
    readProcesses: async () => ({ rootPids: [...rootPids], rows: rows.map((r) => ({ ...r })) }),
    // The process is gone, and so is its pidfile (what a real exit leaves behind).
    signalProcess: (pid, signal) => { signals.push([pid, signal]); rows = rows.filter((r) => r.pid !== pid); rootPids = rootPids.filter((p) => p !== pid); },
  });

  await t.test("Start: an orphan is swept first, then the service starts", async () => {
    setRows([row(4242, "/app/raft-desktop __run s1")], [4242]);
    await host.start();
    assert.deepEqual(signals[0], [4242, "SIGTERM"]);
    assert.deepEqual(calls, ["start"], "started only after the sweep");
  });

  await t.test("launch converge: sweeps before it boots the service too", async () => {
    setRows([row(4242, "/app/raft-desktop __run s1")], [4242]);
    const result = await host.converge();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(signals[0], [4242, "SIGTERM"]);
    assert.deepEqual(calls, ["start"]);
  });

  await t.test("a live service means no sweep (its runner is its own)", async () => {
    setRows([row(100, "/app/raft-desktop __service"), row(101, "/app/raft-desktop __run s1", 100)], [100, 101]);
    await host.start();
    assert.deepEqual([signals, calls], [[], ["start"]]);
  });

  await t.test("nothing running: no sweep, plain start", async () => {
    setRows([], []);
    await host.start();
    assert.deepEqual([signals, calls], [[], ["start"]]);
  });
});
