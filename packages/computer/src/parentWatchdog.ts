// GUI-liveness watchdog for the detached service tree (task #7 anti-orphan).
//
// The desktop app owns the background tree's lifetime now: when the GUI dies
// (crash, force-quit), the `__service` supervisor and every `__run` daemon
// must exit on their own within ~10s, or they linger as bundle-identity
// squatters and orphaned agent hosts — the exact hazard quit-stops-everything
// exists to close. Each detached process polls the parent binding recorded in
// service-version.json (`parentPid` + `parentStartedAt`): the pid must be
// alive AND its start time must still match — a bare kill(pid,0) would be
// fooled by pid reuse. Evidence written by an older GUI (no parentStartedAt
// field) disables the watchdog entirely, so legacy trees keep today's
// behavior until the next GUI converges and rebinds.
import { readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serviceVersionPath } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface ParentBinding {
  parentPid: number;
  /** `ps -o lstart=` output captured at bind time — same source on probe. */
  parentStartedAt: string;
}

/** Parse the parent binding out of a service-version.json payload. Pure. */
export function parseParentBinding(payload: unknown): ParentBinding | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const pid = record.parentPid;
  const startedAt = record.parentStartedAt;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string" || startedAt.trim() === "") return null;
  return { parentPid: pid, parentStartedAt: startedAt.trim() };
}

/** Read a process's start time via `ps -o lstart=`; null when it is gone. */
export async function readProcessStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const value = stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** True when the recorded parent is still the very same process. */
export async function parentStillAlive(binding: ParentBinding): Promise<boolean> {
  const startedAt = await readProcessStartTime(binding.parentPid);
  return startedAt !== null && startedAt === binding.parentStartedAt;
}

/** Read the current parent binding from this home's service-version.json. */
export async function readParentBindingFromFile(slockHome: string): Promise<ParentBinding | null> {
  try {
    return parseParentBinding(JSON.parse(await readFile(serviceVersionPath(slockHome), "utf8")));
  } catch {
    return null;
  }
}

/**
 * Atomic service-version.json update that rebinds the tree to the CURRENT
 * GUI. Called by the desktop host right after it adopts (or spawns) the
 * service: the old binding still names the previous GUI pid, and without the
 * rewrite the freshly adopted tree would be killed by its own watchdog.
 * Missing fields are preserved; the write is tmp-file + rename so a
 * concurrent reader never sees a half-written document.
 */
export async function rebindParentEvidence(slockHome: string, parent: ParentBinding): Promise<void> {
  const file = serviceVersionPath(slockHome);
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return; // No evidence file: nothing adopted, nothing to rebind.
  }
  payload.parentPid = parent.parentPid;
  payload.parentStartedAt = parent.parentStartedAt;
  const tmp = `${file}.rebind.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tmp, file);
}

export interface ParentWatchdogHandle {
  stop(): void;
}

export interface ParentWatchdogDeps {
  /** Re-read the binding every tick (the GUI may rebind while we run). */
  readBinding(): Promise<ParentBinding | null>;
  isAlive(binding: ParentBinding): Promise<boolean>;
  /** Fires once the parent has been missing for `misses` consecutive ticks. */
  onParentLost(): void;
  intervalMs?: number;
  misses?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Poll the parent binding; after `misses` consecutive dead ticks call
 * onParentLost (the caller decides how to exit gracefully) and stop. A null
 * binding (legacy tree, evidence file gone) never trips.
 */
export function startParentWatchdog(deps: ParentWatchdogDeps): ParentWatchdogHandle {
  const intervalMs = deps.intervalMs ?? 3_000;
  const misses = deps.misses ?? 2;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  let consecutiveMisses = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    let alive = true;
    try {
      const binding = await deps.readBinding();
      if (!binding) {
        consecutiveMisses = 0; // legacy/no binding: watchdog disarmed
        return;
      }
      alive = await deps.isAlive(binding);
    } catch {
      alive = false; // probe failure counts as a miss, never as proof of life
    }
    if (alive) {
      consecutiveMisses = 0;
      return;
    }
    consecutiveMisses += 1;
    if (consecutiveMisses >= misses) {
      stopped = true;
      clearIntervalFn(timer);
      deps.onParentLost();
    }
  };
  const timer = setIntervalFn(() => void tick(), intervalMs);
  void tick();
  return { stop: () => { stopped = true; clearIntervalFn(timer); } };
}
