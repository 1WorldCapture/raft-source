// Pins the quit-shutdown ladder (task #7): a graceful window after the stop
// request, then SIGTERM to whole process groups, then SIGKILL; everything
// gone at any tick completes without escalating; SIGKILL-exhausted reports
// the stragglers instead of claiming success; the OS-shutdown mode uses the
// compressed timeouts. Survivor identification is TRUSTED-ROOTS-ONLY: the
// pidfile roots' descendant closure and process groups — never a command-line
// match, so the user's own editor/tail inside ~/.slock/agents cannot be hit.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("shutdown ladder: graceful → group SIGTERM → group SIGKILL → complete/incomplete", async (t) => {
  const { tuningFor, nextShutdownAction, parsePsTable, collectTreeSurvivors, pidAlive, readPidFile, runShutdownTree } =
    await import("./shutdown.ts");

  await t.test("tuning shrinks for system shutdown", () => {
    const normal = tuningFor(false);
    const system = tuningFor(true);
    assert.ok(system.gracefulTimeoutMs < normal.gracefulTimeoutMs);
    assert.ok(system.termTimeoutMs < normal.termTimeoutMs);
  });

  await t.test("all-clear during the graceful window completes without escalating", () => {
    const state = { phase: "stopping" as const, phaseElapsedMs: 0 };
    const step = nextShutdownAction({ state, tuning: tuningFor(false), anyAlive: false });
    assert.equal(step.action, "complete");
    assert.equal(step.state.phase, "done");
  });

  await t.test("graceful timeout escalates to group SIGTERM, then SIGKILL, then reports stragglers", () => {
    const tuning = { gracefulTimeoutMs: 1_000, termTimeoutMs: 500 };
    let state: import("./shutdown.ts").ShutdownState = { phase: "stopping", phaseElapsedMs: 0 };
    let step = nextShutdownAction({ state, tuning, anyAlive: true });
    assert.equal(step.action, "wait");
    state = step.state;
    step = nextShutdownAction({ state: { ...state, phaseElapsedMs: 1_000 }, tuning, anyAlive: true });
    assert.equal(step.action, "sigterm-group");
    assert.equal(step.state.phase, "force-term");
    state = { phase: "force-term", phaseElapsedMs: 500 };
    step = nextShutdownAction({ state, tuning, anyAlive: true });
    assert.equal(step.action, "sigkill-group");
    assert.equal(step.state.phase, "force-kill");
    // SIGKILL window exhausted with survivors → "incomplete" (never a loop,
    // never a false "complete").
    state = { phase: "force-kill", phaseElapsedMs: 500 };
    step = nextShutdownAction({ state, tuning, anyAlive: true });
    assert.equal(step.action, "incomplete");
    // Processes gone right after SIGKILL → clean complete.
    step = nextShutdownAction({ state, tuning, anyAlive: false });
    assert.equal(step.action, "complete");
  });

  await t.test("parsePsTable parses pid/ppid/pgid/command rows and skips junk", () => {
    const ps = [
      "  9001     1  9001 /Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop __service",
      "  9002  9001  9002 /Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop __run abc",
      "  9003  9002  9002 /usr/local/bin/claude --cwd somewhere",
      "  9100   420   420 vim /Users/x/.slock/agents/107a1ceb/MEMORY.md",
      "not a ps row",
      "",
    ].join("\n");
    const rows = parsePsTable(ps);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], { pid: 9001, ppid: 1, pgid: 9001, command: "/Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop __service" });
  });

  await t.test("collectTreeSurvivors: roots' closure and groups only — user processes never matched", () => {
    // Layout: service(9001, group 9001) → runner(9002, group 9002) →
    // claude agent(9003, same group 9002) and a detached agent child(9004,
    // own group 9004 — caught by the descendant closure). The user's vim
    // (9100) edits an agents-workspace file but is NOT ours; so is a
    // same-named binary (9101) outside the tree.
    const rows = parsePsTable([
      "  9001     1  9001 Raft Desktop __service",
      "  9002  9001  9002 Raft Desktop __run abc",
      "  9003  9002  9002 /usr/local/bin/claude --cwd x",
      "  9004  9002  9004 node detached-child-of-runner",
      "  9100   420   420 vim /Users/x/.slock/agents/107a1ceb/MEMORY.md",
      "  9101   420   420 /Applications/Raft Desktop.app --args=unrelated-copy",
    ].join("\n"));
    const survivors = collectTreeSurvivors(rows, [9001]);
    assert.deepEqual([...survivors.pids].sort(), [9001, 9002, 9003, 9004]);
    assert.deepEqual(survivors.groups, [9001], "groups come from the live roots' own pgids");
    // Dead root: nothing collected under it even if children linger.
    const stale = collectTreeSurvivors(rows, [7777]);
    assert.deepEqual(stale.pids, []);
    assert.deepEqual(stale.groups, []);
  });

  await t.test("pidAlive and readPidFile tolerate races and malformed input", async () => {
    const killThrows = (code: string) => (_pid: number, _sig: 0) => {
      const error = new Error("probe") as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    };
    assert.equal(pidAlive(() => {}, 42), true);
    assert.equal(pidAlive(killThrows("ESRCH"), 42), false);
    assert.equal(pidAlive(killThrows("EPERM"), 42), true, "EPERM means alive, not ours");
    assert.equal(pidAlive(() => {}, 0), false);

    const dir = await mkdtemp(path.join(tmpdir(), "raft-shutdown-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const pidFile = path.join(dir, "service.pid");
    const { readFile: fsReadFile } = await import("node:fs/promises");
    await writeFile(pidFile, "12345\n");
    assert.equal(await readPidFile({ readFile: fsReadFile }, pidFile), 12345);
    await writeFile(pidFile, "garbage");
    assert.equal(await readPidFile({ readFile: fsReadFile }, pidFile), null);
    assert.equal(await readPidFile({ readFile: fsReadFile }, path.join(dir, "missing.pid")), null);
  });

  await t.test("runShutdownTree escalates through groups, logs stragglers on SIGKILL exhaustion", async (t2) => {
    const dir = await mkdtemp(path.join(tmpdir(), "raft-shutdown-run-"));
    t2.after(() => rm(dir, { recursive: true, force: true }));
    const logFile = path.join(dir, "shutdown.log");
    const signaled: Array<[number, string]> = [];
    // Tree: runner root dies after SIGTERM; an unkillable agent child stays.
    const psOf = (runnerAlive: boolean, agentAlive: boolean) => [
      runnerAlive ? "  9002     1  9002 runner" : "",
      agentAlive ? "  9003  9002  9002 unkillable-agent" : "",
    ].filter(Boolean).join("\n");
    let runnerAlive = true;
    let agentAlive = true;
    await runShutdownTree({
      now: () => Date.now(),
      sleep: async () => {}, // no real waiting: phaseElapsed advances per tick
      signal: (pid, signal) => {
        signaled.push([pid, signal]);
        if (signal === "SIGTERM" && pid === 9002) runnerAlive = false;
        // 9003 ignores everything (D-state stand-in).
      },
      survivors: async () => ({ rootPids: [9002], psTable: psOf(runnerAlive, agentAlive) }),
      logFile,
      systemShutdown: true, // compressed timeouts so the ladder runs fast
    });
    assert.ok(signaled.some(([pid, sig]) => pid === 9002 && sig === "SIGTERM"));
    assert.ok(signaled.some(([pid, sig]) => pid === 9003 && sig === "SIGKILL"), "agent child escalated to SIGKILL");
    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("sigterm-group"), "timeline records the escalation");
    assert.match(log, /INCOMPLETE: could not terminate \[9002, 9003\]|INCOMPLETE: could not terminate \[9003\]/, "stragglers are named, never claimed clean");
  });
});
