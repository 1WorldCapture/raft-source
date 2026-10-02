// Process primitives used by both the service (CLI adapter) and the
// services/* layer. Neutral relocation target: services/* must NOT
// import from service.ts (a CLI adapter) — these pidfile/liveness
// primitives have no CLI concerns and belong in a sibling-neutral
// module that either layer can depend on.
//
// Package-private: NOT exposed via `@botiverse/raft-computer/lib`
// (RFC v9 §3). The `/internal/` segment is an export hard gate; the
// `exports` field in `packages/computer/package.json` MUST NOT list any
// path under `./src/internal/*`.
//
// Pure relocation from `service.ts` (RFC v9 PR-impl-1 commit 1).
// 0 behavior change — identical signatures, identical bodies; only the
// import path moves.
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

/** Generic pidfile reader by absolute path. Returns null on missing / junk. */
export async function readPidfileAt(pidfilePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidfilePath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Parse the scheduler state field out of one /proc/<pid>/stat line, or null
 * when the line is not a stat line. Pure and exported for tests only.
 *
 * The state is the first field AFTER the closing paren of comm — comm may
 * itself contain spaces and parens ("123 ((launchd) worker) S …"), so the
 * LAST ")" in the line is the one that closes it.
 */
export function parseLinuxStatState(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  return stat.slice(close + 2, close + 3);
}

/**
 * Kernel scheduler state of a Linux process from /proc/<pid>/stat, or null
 * when the entry cannot be read (race-removed pid, permission, non-Linux).
 * A null answer keeps the signal-0 verdict — never invents "exited".
 */
export function readLinuxProcessState(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  return parseLinuxStatState(stat);
}

/**
 * Process state of a Darwin process via `ps -o state=`, or null when ps
 * cannot answer (missing binary, exited-race, spawn failure). A null answer
 * keeps the signal-0 verdict — never invents "exited".
 */
export function readDarwinProcessState(pid: number): string | null {
  let run: ReturnType<typeof spawnSync>;
  try {
    run = spawnSync("ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return null;
  }
  if (run.error || run.status !== 0) return null;
  return run.stdout.trim().slice(0, 1) || null;
}

/**
 * Scheduler states that mean "already exited": Z is an unreaped zombie on
 * both Linux and Darwin; X/x is a Linux process being torn down by the
 * kernel.
 */
export function isExitedProcessState(state: string | null): boolean {
  return state === "Z" || state === "X" || state === "x";
}

/**
 * Liveness via signal 0, refined by kernel process state on Linux and Darwin.
 *
 * Signal 0 alone cannot tell an EXITED-but-not-yet-REAPED process from a
 * running one: a zombie (its parent never waited — e.g. an orphan reparented
 * to a PID 1 that does not reap) still owns its pid and answers signal 0
 * successfully. Every wait-for-exit loop built on that predicate then times
 * out on a process that is already gone (found live in task #10: stop
 * wait, upgrade handover wait, and predecessor-receipt checks all hung on
 * zombies under a non-reaping init).
 *
 * On Linux the refinement reads /proc/<pid>/stat; on Darwin it asks `ps`.
 * Every failure to REFINE — unreadable /proc entry, ps missing, ps error,
 * EPERM on signal 0 — stays CONSERVATIVELY ALIVE: the predicate reports
 * "dead" only on positive exited-state evidence, never on an unanswered
 * question. Windows has no zombie state (handle-based reclamation) and keeps
 * the signal-0 answer; other POSIX platforms without a readable state
 * contract keep it too (documented platform difference).
 *
 * PID reuse: the predicate answers "does THIS pid point at a live process
 * NOW". If the kernel has already reused the pid for a new process, that
 * process is alive and this returns true — the conservative direction for
 * every caller (never treats a live successor as the waited-on corpse).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — alive.
    // Anything else (ESRCH…) means no such process.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  const state =
    process.platform === "linux" ? readLinuxProcessState(pid)
    : process.platform === "darwin" ? readDarwinProcessState(pid)
    : null;
  if (isExitedProcessState(state)) return false;
  return true;
}

export async function writePidfileAt(pidfilePath: string, pid: number): Promise<void> {
  await mkdir(dirname(pidfilePath), { recursive: true });
  await writeFile(pidfilePath, String(pid), { mode: 0o600 });
}

export async function clearPidfileAt(pidfilePath: string): Promise<void> {
  try {
    await unlink(pidfilePath);
  } catch {
    /* ignore */
  }
}
