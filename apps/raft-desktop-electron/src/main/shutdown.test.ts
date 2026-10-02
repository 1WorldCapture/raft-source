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


async function stopFixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "raft-stop-finalize-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 0;
  return {
    scope: new ComputerProcessScope(home, 7),
    snapshot: async () => ({ rootPids: [], rows: [] }),
    signal: () => { assert.fail("an empty tree never needs a signal"); },
    now: () => now,
    sleep: async (ms: number) => { await new Promise<void>((resolve) => setImmediate(resolve)); now += ms; },
    logFile: path.join(dir, "shutdown.log"), systemShutdown: false,
    stopFinishTimeoutMs: 500,
  };
}

test("all-clear waits for stop's lifecycle tail before reporting success", async (t) => {
  const base = await stopFixture(t);
  let finish!: () => void;
  let stopStarted!: () => void;
  const tail = new Promise<void>((resolve) => { finish = resolve; });
  const started = new Promise<void>((resolve) => { stopStarted = resolve; });
  let returned = false;
  let finalized = false;
  const pending = runShutdownTree({ ...base,
    requestStop: async () => { stopStarted(); await tail; finalized = true; },
    sleep: async () => { await tail; },
  }).then((result) => { returned = true; return result; });
  await started;
  await Promise.resolve();
  assert.equal(returned, false);
  finish();
  assert.equal(await pending, true);
  assert.equal(finalized, true);
});

test("all-clear with a hung stop tail reports incomplete within its budget", async (t) => {
  const base = await stopFixture(t);
  assert.equal(await runShutdownTree({ ...base, requestStop: () => new Promise(() => {}) }), false);
  assert.match(await readFile(base.logFile, "utf8"), /finalization timed out/);
});

test("all-clear never hides a failed or cancelled stop tail", async (t) => {
  for (const error of [new Error("lifecycle failed"), new DOMException("cancelled", "AbortError")]) {
    const base = await stopFixture(t);
    assert.equal(await runShutdownTree({ ...base, requestStop: async () => { throw error; } }), false);
    assert.match(await readFile(base.logFile, "utf8"), /INCOMPLETE: stop failed/);
  }
});

test("a timed-out polite stop after force-kill is finalized with one bounded idempotent retry", async (t) => {
  const base = await stopFixture(t);
  let alive = true;
  let calls = 0;
  let finalized = false;
  const result = await runShutdownTree({ ...base,
    snapshot: async () => ({ rootPids: alive ? [100] : [], rows: alive ? [row(100)] : [] }),
    requestStop: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("polite stop timed out"), { code: "STOP_TIMEOUT" });
      assert.equal(alive, false);
      finalized = true;
    },
    tuning: { gracefulTimeoutMs: 500, termTimeoutMs: 500 },
    signal: (pid, signal) => { assert.equal(pid, 100); if (signal === "SIGKILL") alive = false; },
  });
  assert.equal(result, true);
  assert.equal(calls, 2);
  assert.equal(finalized, true);
});

test("timeout retry failure and late processes both prevent a successful quit", async (t) => {
  const base = await stopFixture(t);
  let calls = 0;
  assert.equal(await runShutdownTree({ ...base, requestStop: async () => {
    calls++;
    throw Object.assign(new Error("still not finalized"), { code: "STOP_TIMEOUT" });
  } }), false);
  assert.equal(calls, 2);
  const late = await stopFixture(t);
  let finished = false;
  assert.equal(await runShutdownTree({ ...late,
    requestStop: async () => { finished = true; },
    snapshot: async () => ({ rootPids: [], rows: finished ? [row(102, { agent: true, root: false })] : [] }),
  }), false);
});
