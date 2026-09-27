// Pins the quit-shutdown ladder (task #7): a graceful window after the stop
// request, then SIGTERM to whole process groups, then SIGKILL; everything
// gone at any tick completes without escalating; the OS-shutdown mode uses
// the compressed timeouts. The agent scan must catch the ~/.slock/agents
// workspace marker so orphaned runtimes count as survivors.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("shutdown ladder: graceful → group SIGTERM → group SIGKILL → complete", async (t) => {
  const { tuningFor, nextShutdownAction, scanAgentPids, pidAlive, readPidFile, runShutdownTree, POLL_MS } =
    await import("./shutdown.ts");

  await t.test("tuning shrinks for system shutdown", () => {
    const normal = tuningFor(false);
    const system = tuningFor(true);
    assert.ok(system.gracefulTimeoutMs < normal.gracefulTimeoutMs);
    assert.ok(system.termTimeoutMs < normal.termTimeoutMs);
  });

  await t.test("all-clear during the graceful window completes without escalating", () => {
    const state = { phase: "stopping" as const, phaseElapsedMs: 0 };
    const step = nextShutdownAction({ state, tuning: tuningFor(false), serviceAlive: false, runnerAlive: false, agentAlive: false });
    assert.equal(step.action, "complete");
    assert.equal(step.state.phase, "done");
  });

  await t.test("graceful timeout escalates to group SIGTERM, then SIGKILL, then reports", () => {
    const tuning = { gracefulTimeoutMs: 1_000, termTimeoutMs: 500 };
    let state: import("./shutdown.ts").ShutdownState = { phase: "stopping", phaseElapsedMs: 0 };
    let step = nextShutdownAction({ state, tuning, serviceAlive: true, runnerAlive: true, agentAlive: true });
    assert.equal(step.action, "wait");
    state = step.state;
    step = nextShutdownAction({ state: { ...state, phaseElapsedMs: 1_000 }, tuning, serviceAlive: true, runnerAlive: true, agentAlive: true });
    assert.equal(step.action, "sigterm-group");
    assert.equal(step.state.phase, "force-term");
    state = { phase: "force-term", phaseElapsedMs: 500 };
    step = nextShutdownAction({ state, tuning, serviceAlive: true, runnerAlive: true, agentAlive: true });
    assert.equal(step.action, "sigkill-group");
    assert.equal(step.state.phase, "force-kill");
    // SIGKILL refused (unkillable D-state process): ladder reports, no loop.
    state = { phase: "force-kill", phaseElapsedMs: 500 };
    step = nextShutdownAction({ state, tuning, serviceAlive: true, runnerAlive: true, agentAlive: true });
    assert.equal(step.action, "complete");
    // But processes gone right after SIGKILL → clean complete.
    step = nextShutdownAction({ state, tuning, serviceAlive: false, runnerAlive: false, agentAlive: false });
    assert.equal(step.action, "complete");
  });

  await t.test("scanAgentPids finds agent workspace markers and ignores unrelated lines", () => {
    const agentsDir = "/Users/x/.slock/agents";
    const ps = [
      "  123 /usr/local/bin/claude --cwd /Users/x/.slock/agents/107a1ceb-6201/workspace",
      "  124 /Applications/Raft Desktop.app/Contents/MacOS/Raft Desktop __run 21694c97",
      "  125 /usr/local/bin/node unrelated /Users/x/.slock/agentsMalicious",
      "  notapid text",
      "  126 code /Users/x/projects",
    ].join("\n");
    assert.deepEqual(scanAgentPids(ps, agentsDir), [123]);
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
    await writeFile(pidFile, "12345\n");
    assert.equal(await readPidFile({ readFile }, pidFile), 12345);
    await writeFile(pidFile, "garbage");
    assert.equal(await readPidFile({ readFile }, pidFile), null);
    assert.equal(await readPidFile({ readFile }, path.join(dir, "missing.pid")), null);
  });

  await t.test("runShutdownTree escalates through groups and writes a timeline", async (t2) => {
    const dir = await mkdtemp(path.join(tmpdir(), "raft-shutdown-run-"));
    t2.after(() => rm(dir, { recursive: true, force: true }));
    const logFile = path.join(dir, "shutdown.log");
    const signaled: Array<[number, string]> = [];
    // Survivors: service dies after the first SIGTERM, runner only after
    // SIGKILL, agent is already gone.
    let servicePid = 9001;
    let runnerPid = 9002;
    const deps = {
      slockHome: dir,
      now: () => Date.now(),
      sleep: async () => {}, // no real waiting: phaseElapsed advances per tick
      signal: (pid: number, signal: string) => {
        signaled.push([pid, signal]);
        if (signal === "SIGTERM" && pid === servicePid) servicePid = 0;
        if (signal === "SIGKILL" && pid === runnerPid) runnerPid = 0;
      },
      survivors: async () => ({
        servicePid: servicePid || null,
        runnerPids: runnerPid ? [runnerPid] : [],
        agentPids: [],
      }),
      logFile,
      systemShutdown: false,
    };
    // Compressed tuning via systemShutdown so the ladder runs fast.
    deps.systemShutdown = true;
    await runShutdownTree(deps as Parameters<typeof runShutdownTree>[0]);
    assert.ok(signaled.some(([pid, sig]) => pid === 9001 && sig === "SIGTERM"));
    assert.ok(signaled.some(([pid, sig]) => pid === 9002 && sig === "SIGKILL"));
    const log = await readFile(logFile, "utf8");
    assert.match(log, /shutdown complete/);
    assert.ok(log.includes("sigterm-group"), "timeline records the escalation");
  });
});
