// Pins the quit-shutdown ladder (task #7): a graceful window after the stop
// request, then SIGTERM to whole process groups, then SIGKILL; everything
// gone at any tick completes without escalating; SIGKILL-exhausted reports
// the stragglers instead of claiming success; the OS-shutdown mode uses the
// compressed timeouts. Survivor identification is TRUSTED-ROOTS-ONLY: live
// roots are pinned by pid + start time (a reused pid can never pass as a
// root), the descendant closure runs from live roots alone, dead runners'
// launchd-adopted orphans (ppid 1) are counted only after a Raft-identity
// check, and nothing is ever matched by command line.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const LS = (n: number) => `Mon Sep 27 1${n}:00:00 2026`;

test("shutdown ladder: graceful → group SIGTERM → group SIGKILL → complete/incomplete", async (t) => {
  const { tuningFor, nextShutdownAction, parsePsTable, collectSurvivorPlan, resolveSurvivors, pidAlive, readPidFile, runShutdownTree } =
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
    state = { phase: "force-kill", phaseElapsedMs: 500 };
    step = nextShutdownAction({ state, tuning, anyAlive: true });
    assert.equal(step.action, "incomplete");
    step = nextShutdownAction({ state, tuning, anyAlive: false });
    assert.equal(step.action, "complete");
  });

  await t.test("parsePsTable parses pid/ppid/pgid/lstart/command and skips junk", () => {
    const ps = [
      `  9001     1  9001 ${LS(0)} Raft Desktop __service`,
      "not a ps row",
      "",
    ].join("\n");
    const rows = parsePsTable(ps);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { pid: 9001, ppid: 1, pgid: 9001, lstart: LS(0), command: "Raft Desktop __service" });
  });

  await t.test("survivor plan: pinned live roots; recycled pid degrades to dead root; orphans are candidates only", () => {
    // Layout: service(9001) → runner(9002, group 9002) → claude agent(9003,
    // group 9002) and a detached agent child(9004, own group 9004 — caught by
    // the closure). DEAD runner 8000: its agent child(8001) was adopted by
    // launchd (ppid 1) and still sits in group 8000 → candidate. pid 8000 was
    // REUSED by a stranger (same pid, DIFFERENT lstart) whose own child(8002)
    // must never be matched. The user's vim(9100) edits an agents-workspace
    // file but is not ours.
    const rows = parsePsTable([
      `  9001     1  9001 ${LS(0)} Raft Desktop __service`,
      `  9002  9001  9002 ${LS(1)} Raft Desktop __run abc`,
      `  9003  9002  9002 ${LS(2)} /usr/local/bin/claude --cwd x`,
      `  9004  9002  9004 ${LS(3)} node detached-child-of-runner`,
      `  9100   420   420 ${LS(4)} vim /Users/x/.slock/agents/107a1ceb/MEMORY.md`,
      `  8001     1  8000 ${LS(5)} /usr/local/bin/claude --cwd orphan-after-runner-died`,
      `  8000   420   420 ${LS(9)} /usr/bin/unrelated-reused-pid`,
      `  8002  8000   420 ${LS(9)} child-of-the-stranger`,
    ].join("\n"));
    const pin = new Map([
      [9001, LS(0)],
      [9002, LS(1)],
      // 8000 was recorded with ITS OWN old lstart; the current table shows a
      // different one → reused pid → dead root, never a live root.
      [8000, LS(6)],
    ]);
    const plan = collectSurvivorPlan(rows, [9001, 9002, 8000], pin);
    assert.deepEqual([...plan.owned].sort((a, b) => a - b), [9001, 9002, 9003, 9004]);
    assert.deepEqual(plan.groups, [9001, 9002]);
    assert.deepEqual(plan.orphanCandidates.map((row) => row.pid), [8001], "ppid-1 process in the dead root's group is a candidate");
    assert.ok(!plan.owned.includes(8000), "reused pid itself is not owned");
    assert.ok(!plan.owned.includes(8002), "the stranger's child is not owned");
  });

  await t.test("resolveSurvivors: candidates count only with a Raft identity; unreadable fails closed", async () => {
    const rows = parsePsTable([
      `  8001     1  8000 ${LS(5)} /usr/local/bin/claude --cwd orphan`,
      `  8005     1  8000 ${LS(7)} /usr/local/bin/someone-else-in-recycled-group`,
    ].join("\n"));
    const verified: number[] = [];
    const survivors = await resolveSurvivors(rows, [8000], async (row) => {
      verified.push(row.pid);
      return row.pid === 8001; // only the first carries SLOCK_AGENT_ID
    });
    assert.deepEqual(verified, [8001, 8005], "every candidate is checked");
    assert.deepEqual(survivors.orphanPids, [8001]);
    assert.deepEqual(survivors.pids, [8001]);
    const closed = await resolveSurvivors(rows, [8000], async () => {
      throw new Error("ps eww failed");
    });
    assert.deepEqual(closed.orphanPids, [], "fail closed on unreadable identity");
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

  await t.test("runShutdownTree: SIGTERM root, SIGKILL verified orphan; stragglers logged on exhaustion", async (t2) => {
    const dir = await mkdtemp(path.join(tmpdir(), "raft-shutdown-run-"));
    t2.after(() => rm(dir, { recursive: true, force: true }));
    const logFile = path.join(dir, "shutdown.log");
    const signaled: Array<[number, string]> = [];
    // Root runner 9002 dies after SIGTERM. Its agent child 9003 is then
    // launchd-adopted (ppid 1) but stays in group 9002 — the real orphan
    // shape — and ignores SIGKILL (D-state stand-in).
    const psOf = (runnerAlive: boolean, agentAlive: boolean) =>
      [
        runnerAlive ? `  9002     1  9002 ${LS(1)} runner` : "",
        agentAlive ? `  9003     1  9002 ${LS(2)} /usr/local/bin/claude orphan-agent` : "",
      ]
        .filter(Boolean)
        .join("\n");
    let runnerAlive = true;
    const agentAlive = true;
    await runShutdownTree({
      now: () => Date.now(),
      sleep: async () => {}, // phaseElapsed advances per tick, no real waiting
      signal: (pid, signal) => {
        signaled.push([pid, signal]);
        if (signal === "SIGTERM" && pid === 9002) runnerAlive = false;
      },
      survivors: async () => ({ rootPids: [9002], psTable: psOf(runnerAlive, agentAlive) }),
      verifyOrphan: async (row) => row.pid === 9003, // carries SLOCK_AGENT_ID
      logFile,
      systemShutdown: true, // compressed timeouts so the ladder runs fast
    });
    assert.ok(signaled.some(([pid, sig]) => pid === 9002 && sig === "SIGTERM"));
    assert.ok(signaled.some(([pid, sig]) => pid === 9003 && sig === "SIGKILL"), "verified orphan escalated to SIGKILL");
    const log = await readFile(logFile, "utf8");
    assert.ok(log.includes("sigterm-group"), "timeline records the escalation");
    assert.match(log, /INCOMPLETE: could not terminate \[9003\]/, "stragglers named, never claimed clean");
  });
});
