// Task #10: isProcessAlive must distinguish an EXITED-but-unreaped process
// (a zombie) from a running one. Signal 0 alone answers both identically,
// which turned every wait-for-exit loop into a guaranteed timeout under a
// non-reaping init (stop wait, upgrade handover wait, predecessor-receipt
// checks).
//
// The zombie fixture is the SAME on every platform (review round 3): a small
// Python parent fork()s a child that exits immediately and HOLDS the corpse
// unreaped until the test sends it one stdin line — then the parent actually
// waitpid()s the child and exits. Unlike a shell (bash reaps finished
// background jobs before every next command; dash cannot be commanded
// portably), a Python parent deterministically owns the zombie and
// deterministically reaps it. Tests skip explicitly when python3 is absent.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  isExitedProcessState,
  isProcessAlive,
  parseLinuxStatState,
  readDarwinProcessState,
  readLinuxProcessState,
} from "./process-primitives.js";

const isLinux = process.platform === "linux";

// fork a child that exits at once; report its pid; HOLD the zombie until one
// stdin line arrives; then actually waitpid() it and exit cleanly.
const PYTHON_PARENT = [
  "import os, sys",
  "pid = os.fork()",
  "if pid == 0:",
  "    os._exit(0)",
  "print(pid, flush=True)",
  "sys.stdin.readline()",
  "os.waitpid(pid, 0)",
].join("\n");

let python3: string | null | undefined;
function pythonParentCommand(): string | null {
  if (python3 !== undefined) return python3;
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["-c", "print(1)"], { timeout: 5_000 });
    if (probe.status === 0) {
      python3 = candidate;
      return python3;
    }
  }
  python3 = null;
  return null;
}

interface ZombieFixture {
  parent: ChildProcessWithoutNullStreams;
  zombiePid: number;
}

async function manufactureZombie(): Promise<ZombieFixture | "skip"> {
  const python = pythonParentCommand();
  if (python === null) {
    return "skip"; // fixture tool unavailable on this host: explicit skip
  }
  const parent = spawn(python, ["-c", PYTHON_PARENT], {
    stdio: ["pipe", "pipe", "inherit"],
  }) as ChildProcessWithoutNullStreams;
  let out = "";
  parent.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  while (!out.trim() && parent.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const zombiePid = Number.parseInt(out.trim().split("\n")[0]!, 10);
  if (!Number.isInteger(zombiePid) || zombiePid <= 0) {
    parent.kill("SIGKILL");
    throw new Error(`python parent reported pid "${out.trim()}"`);
  }
  // Wait past the child's exit while the never-waiting parent still lives.
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { parent, zombiePid };
}

/** Review round 3: teardown runs in finally — parent waits child, we wait parent. */
async function reapFixture(fixture: ZombieFixture): Promise<void> {
  if (fixture.parent.exitCode === null && !fixture.parent.stdin.destroyed) {
    try { fixture.parent.stdin.write("\n"); } catch { /* already gone */ }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    fixture.parent.once("close", () => { clearTimeout(timer); resolve(); });
  });
  if (fixture.parent.exitCode === null) {
    try { fixture.parent.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

test("parseLinuxStatState: state survives comm containing spaces and nested parens", () => {
  // comm may legally contain spaces, parens, even "(launchd) worker".
  assert.equal(parseLinuxStatState("123 (node) S 1 2 3"), "S");
  assert.equal(parseLinuxStatState("42 (Chrome Helper (Renderer)) R 1"), "R");
  assert.equal(parseLinuxStatState("7 ((weird) name (x)) Z 1"), "Z");
  assert.equal(parseLinuxStatState("9 (a b c) X"), "X");
  assert.equal(parseLinuxStatState("9 (a b c) x"), "x");
  // Not a stat line: no closing comm paren.
  assert.equal(parseLinuxStatState("garbage without parens"), null);
  assert.equal(parseLinuxStatState(""), null);
});

test("isExitedProcessState: only kernel exit states read as exited", () => {
  assert.equal(isExitedProcessState("Z"), true); // zombie, awaiting reap
  assert.equal(isExitedProcessState("X"), true); // dead, being torn down
  assert.equal(isExitedProcessState("x"), true);
  assert.equal(isExitedProcessState("R"), false); // running
  assert.equal(isExitedProcessState("S"), false); // sleeping
  assert.equal(isExitedProcessState("D"), false); // uninterruptible sleep
  assert.equal(isExitedProcessState("T"), false); // stopped (suspended/traced)
  assert.equal(isExitedProcessState("U"), false); // darwin uninterruptible wait
  assert.equal(isExitedProcessState(""), false);
  assert.equal(isExitedProcessState(null), false); // unanswered is NOT exited
});

test("isProcessAlive: rejects non-pid values before any kernel call", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test("isProcessAlive: a pid with no process reads as dead", () => {
  // Above the kernel pid ceiling there is never a process; signal 0 must
  // answer ESRCH on every platform.
  const maxPid = isLinux
    ? Number.parseInt(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(), 10)
    : 999_999_999;
  assert.equal(isProcessAlive(maxPid + 1), false);
});

test("isProcessAlive: EPERM on signal 0 stays conservatively alive", () => {
  // The process exists but belongs to someone else — alive, by permission
  // evidence rather than state evidence.
  const kill = vi.spyOn(process, "kill").mockImplementation((() => {
    const err = new Error("operation not permitted") as NodeJS.ErrnoException;
    err.code = "EPERM";
    throw err;
  }) as unknown as typeof process.kill);
  try {
    assert.equal(isProcessAlive(424_242), true);
  } finally {
    kill.mockRestore();
  }
});

test("isProcessAlive on Linux: /proc read failure keeps the alive verdict", async () => {
  if (!isLinux) return;
  // A RUNNING self, with the /proc read forced to fail: the predicate must
  // fall back to the signal-0 answer (alive), never guess "exited". The fs
  // module is replaced via module mock (not spyOn: on some Node versions the
  // builtin's exports are non-configurable and cannot be spied on).
  vi.resetModules();
  vi.doMock("node:fs", async (orig) => {
    const real = await orig<typeof import("node:fs")>();
    const failing = () => {
      throw Object.assign(new Error("i/o error"), { code: "EIO" });
    };
    return { ...real, readFileSync: failing };
  });
  try {
    const mod = await import("./process-primitives.js");
    assert.equal(mod.isProcessAlive(process.pid), true);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});

test("Darwin: ps failure AND timeout both stay conservatively alive (parameterized)", async () => {
  if (process.platform !== "darwin") return; // darwin refinement only
  // Both unusable-ps shapes must read as "no answer" (null state), keeping
  // the signal-0 verdict for a running process — never guessing "exited".
  const brokenSpawnResults = [
    { label: "spawn error", result: { error: new Error("ps unavailable"), status: null, stdout: "" } },
    { label: "timeout kill", result: { error: null, status: null, signal: "SIGTERM", stdout: "" } },
  ] as const;
  for (const { label, result } of brokenSpawnResults) {
    vi.resetModules();
    vi.doMock("node:child_process", async (orig) => {
      const real = await orig<typeof import("node:child_process")>();
      return { ...real, spawnSync: () => result };
    });
    try {
      const mod = await import("./process-primitives.js");
      assert.equal(mod.readDarwinProcessState(process.pid), null, label);
      assert.equal(mod.isProcessAlive(process.pid), true, label);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  }
});

test("state evidence decides: a RUNNING successor on a live pid reads alive, a Z reads dead (mocked, deterministic)", async () => {
  // PID reuse is decided by STATE EVIDENCE, not by kernel luck: with signal 0
  // succeeding and the state reader answering a running state, the pid reads
  // alive (the conservative direction for a reused pid); with a Z state it
  // reads dead. Both branches are forced through mocks — no reliance on the
  // kernel happening to reuse a pid.
  const liveStat = "4242 (some successor) R 1 2 3";
  const deadStat = "4242 (some successor) Z 1 2 3";
  if (isLinux) {
    vi.resetModules();
    vi.doMock("node:fs", async (orig) => {
      const real = await orig<typeof import("node:fs")>();
      return { ...real, readFileSync: (p: unknown) => (String(p).includes("/4242/stat") ? liveStat : deadStat) };
    });
    try {
      const mod = await import("./process-primitives.js");
      const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as unknown as typeof process.kill);
      try {
        assert.equal(mod.isProcessAlive(4242), true, "running successor state must read alive");
      } finally {
        kill.mockRestore();
      }
      const killZ = vi.spyOn(process, "kill").mockImplementation((() => true) as unknown as typeof process.kill);
      try {
        // Flip the mock answer to the dead line: same pid, Z state, dead.
        vi.doMock("node:fs", async (orig) => {
          const real = await orig<typeof import("node:fs")>();
          return { ...real, readFileSync: () => deadStat };
        });
        vi.resetModules();
        const modZ = await import("./process-primitives.js");
        assert.equal(modZ.isProcessAlive(4242), false, "Z state must read dead");
      } finally {
        killZ.mockRestore();
        vi.doUnmock("node:fs");
        vi.resetModules();
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  } else if (process.platform === "darwin") {
    for (const [label, psOut, expected] of [
      ["running successor", "R\n", true],
      ["zombie", "Z\n", false],
    ] as const) {
      vi.resetModules();
      vi.doMock("node:child_process", async (orig) => {
        const real = await orig<typeof import("node:child_process")>();
        return { ...real, spawnSync: () => ({ error: null, status: 0, stdout: psOut }) };
      });
      const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as unknown as typeof process.kill);
      try {
        const mod = await import("./process-primitives.js");
        assert.equal(mod.isProcessAlive(4242), expected, label);
      } finally {
        kill.mockRestore();
        vi.doUnmock("node:child_process");
        vi.resetModules();
      }
    }
  }
});

test("isProcessAlive: a fork-held unreaped zombie reads as dead; fixture reaps itself in finally", { timeout: 20_000 }, async () => {
  if (process.platform === "win32") return; // zombie semantics under test are POSIX
  const fixture = await manufactureZombie();
  if (fixture === "skip") return; // python3 unavailable: explicit skip (see header)
  try {
    // The zombie really exists and really exited (positive evidence both ways).
    if (isLinux) {
      assert.equal(readLinuxProcessState(fixture.zombiePid), "Z");
    }
    let signal0Succeeds = false;
    try { process.kill(fixture.zombiePid, 0); signal0Succeeds = true; } catch { /* reaped already */ }
    assert.equal(
      signal0Succeeds,
      true,
      "precondition failed: zombie vanished before assertion (parent died early?)",
    );
    // The refined predicate reads the corpse as dead.
    assert.equal(isProcessAlive(fixture.zombiePid), false);
    // And the live parent still reads alive through the same refined path.
    assert.equal(isProcessAlive(fixture.parent.pid!), true);
  } finally {
    // Review round 3: teardown ALWAYS runs — the parent actually waitpid()s
    // its child on our stdin line, we wait for the parent to exit, and the
    // no-residue claims below are checked outside the assertion block.
    await reapFixture(fixture);
  }
  // No residue: both the parent and the reaped zombie are gone.
  assert.equal(isProcessAlive(fixture.parent.pid!), false, "parent must exit after waitpid");
  assert.equal(isProcessAlive(fixture.zombiePid), false, "zombie must be reaped by the parent");
});

test("readLinuxProcessState: parses the self stat line on Linux", () => {
  if (!isLinux) return; // /proc/<pid>/stat is a Linux contract
  const state = readLinuxProcessState(process.pid);
  assert.ok(state !== null, "self /proc/<pid>/stat must be readable on Linux");
  assert.match(state!, /^[A-Za-z]$/);
  assert.equal(isExitedProcessState(state), false);
});
