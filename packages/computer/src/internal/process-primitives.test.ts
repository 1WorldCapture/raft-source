// Task #10: isProcessAlive must distinguish an EXITED-but-unreaped process
// (a zombie) from a running one. Signal 0 alone answers both identically,
// which turned every wait-for-exit loop into a guaranteed timeout under a
// non-reaping init (stop wait, upgrade handover wait, predecessor-receipt
// checks). The zombie below is MANUFACTURED, not scavenged: a shell starts a
// background sleep and then execs another sleep, so the first sleep's parent
// is a process that never waits — it becomes a deterministic zombie we own
// and reap when the parent dies.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  isExitedProcessState,
  isProcessAlive,
  parseLinuxStatState,
  readLinuxProcessState,
} from "./process-primitives.js";

const isPosix = process.platform === "linux" || process.platform === "darwin";
const isLinux = process.platform === "linux";

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

test("isProcessAlive: unreadable state refinement stays conservatively alive", () => {
  // EPERM on signal 0: the process exists but belongs to someone else.
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
  // fall back to the signal-0 answer (alive), never guess "exited".
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const readMock = vi
    .spyOn(fs, "readFileSync")
    .mockImplementation(() => {
      throw Object.assign(new Error("i/o error"), { code: "EIO" });
    });
  // readFileSync is captured at module load; re-import the module under test
  // with the mock installed so the failure path actually executes.
  vi.resetModules();
  vi.doMock("node:fs", async (orig) => {
    const real = await orig<typeof import("node:fs")>();
    return { ...real, readFileSync: readMock };
  });
  try {
    const mod = await import("./process-primitives.js");
    assert.equal(mod.isProcessAlive(process.pid), true);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
    readMock.mockRestore();
  }
});

const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    // Reap the manufactured tree: killing the shell parent releases the
    // zombie (kernel reparents it) and libuv collects our direct child.
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

test("isProcessAlive: a manufactured unreaped zombie reads as dead (deterministic)", { timeout: 15_000 }, async () => {
  if (!isPosix) return; // zombie semantics under test are POSIX
  // sh starts `sleep ZOMBIE_MS` in the background (printing its pid) and then
  // execs a longer sleep: the background sleep's parent becomes a process
  // that never waits, so after it exits it is a REAL zombie we deterministically
  // own — on both Linux and Darwin, without depending on the host init.
  const shell = spawn(
    "sh",
    ["-c", "sleep 0.4 & echo $!; exec sleep 10"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  spawned.push(shell);
  let out = "";
  shell.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  while (!out.trim() && shell.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const zombiePid = Number.parseInt(out.trim().split("\n")[0]!, 10);
  assert.ok(Number.isInteger(zombiePid) && zombiePid > 0, `shell reported pid "${out.trim()}"`);
  // Wait past the child's exit, while its never-waiting parent still lives.
  await new Promise((resolve) => setTimeout(resolve, 900));

  // The zombie really exists and really exited (positive evidence both ways).
  if (isLinux) {
    assert.equal(readLinuxProcessState(zombiePid), "Z");
  }
  let signal0Succeeds = false;
  try { process.kill(zombiePid, 0); signal0Succeeds = true; } catch { /* reaped already */ }
  assert.equal(
    signal0Succeeds,
    true,
    "precondition failed: zombie vanished before assertion (parent died early?)",
  );
  // The refined predicate reads the corpse as dead.
  assert.equal(isProcessAlive(zombiePid), false);
  // And a live sibling (the parent) still reads alive through the same path.
  assert.equal(isProcessAlive(shell.pid!), true);
});

test("readLinuxProcessState: parses the self stat line on Linux", () => {
  if (!isLinux) return; // /proc/<pid>/stat is a Linux contract
  const state = readLinuxProcessState(process.pid);
  assert.ok(state !== null, "self /proc/<pid>/stat must be readable on Linux");
  assert.match(state!, /^[A-Za-z]$/);
  assert.equal(isExitedProcessState(state), false);
});

test("spawnSync sanity: the manufacturing recipe works on this host", () => {
  if (!isPosix) return;
  const probe = spawnSync("sh", ["-c", "sleep 0.1 & echo $!; exec sleep 0.1"]);
  assert.equal(probe.status, 0);
});
