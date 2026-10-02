// Task #10: isProcessAlive must distinguish an EXITED-but-unreaped process
// (a zombie) from a running one. Signal 0 alone answers both identically,
// which turned every wait-for-exit loop into a guaranteed timeout under a
// non-reaping init (stop wait, upgrade handover wait, predecessor-receipt
// checks). These tests cover the state-parsing seam and the refined
// predicate; the true-zombie integration behavior is asserted opportunistically
// when the host happens to expose one in /proc.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isExitedProcessState,
  isProcessAlive,
  readLinuxProcessState,
} from "./process-primitives.js";

const isLinux = process.platform === "linux";

test("isExitedProcessState: only kernel exit states read as exited", () => {
  assert.equal(isExitedProcessState("Z"), true); // zombie, awaiting reap
  assert.equal(isExitedProcessState("X"), true); // dead, being torn down
  assert.equal(isExitedProcessState("x"), true);
  assert.equal(isExitedProcessState("R"), false); // running
  assert.equal(isExitedProcessState("S"), false); // sleeping
  assert.equal(isExitedProcessState("D"), false); // uninterruptible sleep
  assert.equal(isExitedProcessState("T"), false); // stopped (traced/suspended)
  assert.equal(isExitedProcessState(""), false);
  assert.equal(isExitedProcessState(null), false); // unreadable is NOT exited
});

test("readLinuxProcessState: parses past a comm containing spaces and parens", () => {
  if (!isLinux) return; // /proc/<pid>/stat is a Linux contract
  // Our own pid: comm may be "node"; a real running process must parse.
  const state = readLinuxProcessState(process.pid);
  assert.ok(state !== null, "self /proc/<pid>/stat must be readable on Linux");
  assert.match(state!, /^[A-Za-z]$/);
  assert.equal(isExitedProcessState(state), false);
  // A pid with no /proc entry (kernel.pid_max boundary) reads as null, never
  // as a state — the caller keeps the signal-0 verdict for unreadable.
  const maxPid = Number.parseInt(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(), 10);
  assert.equal(readLinuxProcessState(maxPid + 1), null);
});

test("isProcessAlive: rejects non-pid values before any kernel call", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(1.5), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test("isProcessAlive: a reaped-away exited pid reads as dead", () => {
  // Spawn a short-lived child and let libuv reap it, so the pid is a true
  // corpse: signal 0 must answer ESRCH on every platform.
  const run = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(run.status, 0);
  // The child was reaped; find a definitely-unused pid rather than guessing
  // the recycled one: spawnSync does not expose it, so use pid_max boundary.
  const maxPid = isLinux
    ? Number.parseInt(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim(), 10)
    : 4_194_304;
  assert.equal(isProcessAlive(maxPid + 1), false);
});

test("isProcessAlive: a zombie found in /proc reads as dead (opportunistic)", () => {
  // Deterministically MANUFACTURING a zombie from Node is not possible
  // (libuv auto-reaps children), and hosts whose PID 1 reaps never keep one.
  // When the system does expose a zombie — the exact production shape this
  // fix targets — assert the refined predicate reads it dead; otherwise this
  // test documents why it skipped. (The container reproduction for task #10
  // ran under a non-reaping init: exit within 1.5s, stop still timed out.)
  if (!isLinux) return;
  let zombiePid: number | null = null;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    const close = stat.lastIndexOf(")");
    if (close === -1) continue;
    if (stat.slice(close + 2, close + 3) === "Z") {
      zombiePid = Number.parseInt(entry, 10);
      break;
    }
  }
  if (zombiePid === null) return; // no zombie exposed on this host: skip
  assert.equal(
    isProcessAlive(zombiePid),
    false,
    `zombie pid ${zombiePid} answers signal 0 but must read as dead`,
  );
});
