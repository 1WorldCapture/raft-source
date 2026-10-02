import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComputerProcessScope, parseComputerProcesses, type ComputerProcess } from "./computerProcesses.ts";
import { nextShutdownAction, parsePsTable, runShutdownTree, tuningFor } from "./shutdown.ts";

const home = "/tmp/raft-owned";
const foreign = "/tmp/raft-owned-other";
const start = "Fri Oct 2 14:00:00 2026";
const row = (pid: number, changes: Partial<ComputerProcess> = {}): ComputerProcess => ({
  pid, ppid: 1, pgid: 50, lstart: start, command: "node __service", home, agent: false, root: true, ...changes,
});

test("ps parses a padded single-digit day and strips environment from process identity", () => {
  const rows = parseComputerProcesses(`100 1 50 Fri Oct  2 14:00:00 2026 node __service RAFT_HOME=${home} SLOCK_HOME=${home} TOKEN=secret`);
  assert.equal(rows[0].home, home);
  assert.equal(rows[0].lstart, start);
  assert.equal(rows[0].command, "node __service");
  assert.equal(parsePsTable("junk").length, 0);
});

test("root evidence requires an exact path; conflicting or missing roots fail closed", () => {
  const parse = (command: string) => parseComputerProcesses(`100 1 50 ${start} ${command}`)[0];
  assert.equal(parse(`node __run abc RAFT_HOME=${foreign}`).home, foreign);
  assert.equal(parse(`node __service --slock-home ${home}`).home, home);
  assert.equal(parse(`node __service RAFT_HOME=${home} SLOCK_HOME=${foreign}`).home, null);
  assert.equal(parse("node __service SLOCK_AGENT_ID=a").home, null);
  assert.equal(parse(`node __service RAFT_HOME=${home} with spaces NEXT=value`).home, `${home} with spaces`);
});

test("mixed PGID: descendants are owned, foreign root, unknown member and GUI never are", () => {
  const scope = new ComputerProcessScope(home, 7);
  const snapshot = { rootPids: [100], rows: [row(100), row(101, { ppid: 100, root: false, command: "tool" }),
    row(200, { home: foreign }), row(201, { ppid: 100, home: foreign }),
    row(300, { root: false, home: null }), row(7), row(8, { ppid: 7, agent: true, root: false, command: "GUI Helper" })] };
  scope.assertRoots(snapshot);
  assert.deepEqual(scope.observe(snapshot).map((p) => p.pid), [100, 101]);
});

test("retains a detached tool after root death and pidfile deletion; verifies root-bound orphan agents", () => {
  const scope = new ComputerProcessScope(home, 7);
  scope.observe({ rootPids: [100], rows: [row(100), row(101, { ppid: 100, command: "tool", root: false })] });
  const owned = scope.observe({ rootPids: [], rows: [row(101, { ppid: 1, pgid: 101, command: "tool", root: false }),
    row(102, { command: "agent", agent: true, root: false }), row(200, { home: foreign, agent: true, root: false })] });
  assert.deepEqual(owned.map((p) => p.pid), [101, 102]);
});

test("same-root PID reuse never inherits ownership or a signal", () => {
  const scope = new ComputerProcessScope(home, 7);
  const identity = row(100);
  scope.observe({ rootPids: [100], rows: [identity] });
  const reused = row(100, { lstart: "Fri Oct 2 15:00:00 2026" });
  assert.equal(scope.matches(identity, reused), false);
  assert.deepEqual(scope.observe({ rootPids: [100], rows: [reused] }), []);
  assert.throws(() => scope.assertRoots({ rootPids: [100], rows: [reused] }), /启动|无法确认/);
});

test("foreign or unreadable pidfile root blocks before any stop action", async () => {
  const scope = new ComputerProcessScope(home, 7);
  for (const item of [row(100, { home: foreign }), row(100, { home: null }), row(7)]) {
    scope.assertRoots({ rootPids: [], rows: [] });
    assert.throws(() => scope.assertRoots({ rootPids: [item.pid], rows: [item] }), /未接管或停止/);
  }
});

test("graceful all-clear exits early, system shutdown has shorter deadlines", () => {
  assert.equal(nextShutdownAction({ state: { phase: "stopping", phaseElapsedMs: 0 }, tuning: tuningFor(false), anyAlive: false }).action, "complete");
  assert.ok(tuningFor(true).gracefulTimeoutMs < tuningFor(false).gracefulTimeoutMs);
});

test("shutdown captures before stop, retains child after pidfile removal, escalates only positive owned PIDs", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "raft-shutdown-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scope = new ComputerProcessScope(home, 7);
  let now = 0;
  let rootLive = true;
  let childLive = true;
  let stopRequested = false;
  const signals: Array<[number, string]> = [];
  const foreignRow = row(200, { home: foreign });
  const complete = await runShutdownTree({
    scope,
    snapshot: async () => ({ rootPids: rootLive ? [100] : [], rows: [
      ...(rootLive ? [row(100)] : []),
      ...(childLive ? [row(101, { ppid: rootLive ? 100 : 1, pgid: 101, command: "tool", root: false })] : []),
      foreignRow, row(7), row(300, { home: null, root: false }),
    ] }),
    requestStop: async () => { stopRequested = true; rootLive = false; },
    signal: (pid, signal) => { signals.push([pid, signal]); if (pid === 101 && signal === "SIGKILL") childLive = false; },
    now: () => now, sleep: async (ms) => { now += ms; }, logFile: path.join(dir, "shutdown.log"),
    tuning: { gracefulTimeoutMs: 500, termTimeoutMs: 500 }, systemShutdown: false,
  });
  assert.equal(stopRequested, true);
  assert.equal(complete, true);
  assert.deepEqual(signals, [[101, "SIGTERM"], [101, "SIGKILL"]]);
  assert.match(await readFile(path.join(dir, "shutdown.log"), "utf8"), /shutdown complete/);
});

test("fresh pre-signal snapshot prevents a same-root PID replacement from receiving either signal", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "raft-shutdown-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let reads = 0;
  let now = 0;
  const signals: number[] = [];
  const complete = await runShutdownTree({
    scope: new ComputerProcessScope(home, 7),
    snapshot: async () => {
      reads++;
      // First capture + first escalation see the old process; the immediate
      // pre-signal read sees its PID reused, even though the root is identical.
      return { rootPids: reads < 3 ? [100] : [], rows: [row(100, reads < 3 ? {} : { lstart: "Fri Oct 2 15:00:00 2026" })] };
    },
    requestStop: async () => {}, signal: (pid) => signals.push(pid),
    now: () => now, sleep: async (ms) => { now += ms; }, logFile: path.join(dir, "shutdown.log"),
    tuning: { gracefulTimeoutMs: 0, termTimeoutMs: 500 }, systemShutdown: false,
  });
  assert.equal(complete, true);
  assert.deepEqual(signals, []);
});

test("identity becomes unreadable: no signal and incomplete is reported", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "raft-shutdown-unreadable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 0;
  let reads = 0;
  const signals: number[] = [];
  const result = await runShutdownTree({
    scope: new ComputerProcessScope(home, 7),
    snapshot: async () => ({ rootPids: [100], rows: [row(100, ++reads > 1 ? { home: null } : {})] }),
    requestStop: async () => {}, signal: (pid) => signals.push(pid), now: () => now,
    sleep: async (ms) => { now += ms; }, logFile: path.join(dir, "shutdown.log"),
    tuning: { gracefulTimeoutMs: 500, termTimeoutMs: 500 }, systemShutdown: false,
  });
  assert.equal(result, false);
  assert.deepEqual(signals, []);
  assert.match(await readFile(path.join(dir, "shutdown.log"), "utf8"), /INCOMPLETE/);
});


test("unreadable descendant remains unresolved after parent exit and is never claimed", () => {
  const scope = new ComputerProcessScope(home, 7);
  const child = row(101, { home: null, ppid: 100, root: false, command: "tool" });
  assert.deepEqual(scope.observe({ rootPids: [100], rows: [row(100), child] }).map((p) => p.pid), [100]);
  const detached = { rootPids: [], rows: [{ ...child, ppid: 1 }] };
  assert.deepEqual(scope.observe(detached), []);
  assert.deepEqual(scope.unverified(detached), [101]);
});
