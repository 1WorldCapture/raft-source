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
  let sweepLeft: Array<{ pid: number }> = [];
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
    // The lib knows the alias spelling of the home (here a fixed one) in addition to the realpath and the configured path.
    homeProcessSpellings: (primary: string, original: string | null) => [primary, original, "ALIAS-SPELLING"].filter((v): v is string => v !== null),
    // The Computer's own sweep: the orphans are gone afterwards (and so are their pidfiles).
    // Attribution as the real scan does it: a process counts for the home if ANY spelling matches the spelling it carries.
    defaultScanHomeProcesses: async (spellings: string[]) =>
      rows.filter((r) => spellings.includes((r as { spelling?: string }).spelling ?? testHome)).map((r) => ({ pid: r.pid, kind: /__service/.test(r.command) ? "service" : "runner", serverId: null })),
    sweepHomeProcesses: async (spellings: string[]) => {
      for (const r of rows) signals.push([r.pid, `sweep:${spellings.length > 0}`]);
      rows = []; rootPids = [];
      return sweepLeft;
    },
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
  });

  await t.test("Start: an orphan is swept first, then the service starts", async () => {
    setRows([row(4242, "/app/raft-desktop __run s1")], [4242]);
    await host.start();
    assert.deepEqual(signals[0], [4242, "sweep:true"]);
    assert.deepEqual(calls, ["start"], "started only after the sweep");
  });

  await t.test("launch converge: sweeps before it boots the service too", async () => {
    setRows([row(4242, "/app/raft-desktop __run s1")], [4242]);
    const result = await host.converge();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(signals[0], [4242, "sweep:true"]);
    assert.deepEqual(calls, ["start"]);
  });

  await t.test("a live service means no sweep (its runner is its own)", async () => {
    setRows([row(100, "/app/raft-desktop __service"), row(101, "/app/raft-desktop __run s1", 100)], [100, 101]);
    await host.start();
    assert.deepEqual([signals, calls], [[], ["start"]]);
  });

  await t.test("MIXED spellings: a live service carrying the ALIAS spelling + an orphan carrying the realpath: nothing is swept", async () => {
    setRows([row(100, "/app/raft-desktop __service"), row(4242, "/app/raft-desktop __run s1")], [100, 4242]);
    (rows[0] as { spelling?: string }).spelling = "ALIAS-SPELLING"; // the healthy service was launched with RAFT_HOME=<alias>
    await host.start();
    assert.deepEqual(signals, [], "the healthy service and its agents were not touched");
    assert.deepEqual(calls, ["start"]);
  });

  await t.test("an orphan that survives the sweep stops the start (nothing is started over it)", async () => {
    setRows([row(4242, "/app/raft-desktop __run s1")], [4242]);
    sweepLeft = [{ pid: 4242 }];
    await assert.rejects(() => host.start(), /could not be cleaned up/);
    assert.deepEqual(calls, []);
    sweepLeft = [];
  });

  await t.test("nothing running: no sweep, plain start", async () => {
    setRows([], []);
    await host.start();
    assert.deepEqual([signals, calls], [[], ["start"]]);
  });
});
