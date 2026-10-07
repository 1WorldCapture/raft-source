// Bounded shutdown of verified processes in one Computer state root.
// Capture identities before asking the service to stop; never signal groups.
import { appendFile, readFile } from "node:fs/promises";
import type { ComputerProcessScope, ComputerProcessSnapshot } from "./computerProcesses.js";

export type ShutdownPhase = "stopping" | "force-term" | "force-kill" | "done";

export type ShutdownAction = "wait" | "sigterm" | "sigkill" | "complete" | "incomplete";

export interface ShutdownTuning {
  /** Graceful window after requesting the service stop before escalating. */
  gracefulTimeoutMs: number;
  /** Window after SIGTERM before SIGKILL. */
  termTimeoutMs: number;
}

/** Timeouts shrink when the OS is already shutting down — never stall logout. */
export function tuningFor(systemShutdown: boolean): ShutdownTuning {
  return systemShutdown
    ? { gracefulTimeoutMs: 5_000, termTimeoutMs: 3_000 }
    : { gracefulTimeoutMs: 15_000, termTimeoutMs: 5_000 };
}

export interface ShutdownState {
  phase: ShutdownPhase;
  /** ms spent in the CURRENT phase. */
  phaseElapsedMs: number;
}

/**
 * Pure transition. Call once per poll tick with fresh liveness; the returned
 * action is what the caller must do BEFORE the next tick.
 *  - stopping: the IPC stop request is in flight; wait out the graceful window
 *    while still checking liveness every tick (all-clear completes early).
 *  - force-term / force-kill: signal every verified surviving process, wait the window;
 *    still alive → escalate; gone → complete; SIGKILL window exhausted →
 *    "incomplete" (report, never loop) — the caller logs the stragglers.
 */
export function nextShutdownAction(input: {
  state: ShutdownState;
  tuning: ShutdownTuning;
  anyAlive: boolean;
}): { state: ShutdownState; action: ShutdownAction } {
  const { state, tuning } = input;
  const advance = (phase: ShutdownPhase): ShutdownState => ({ phase, phaseElapsedMs: 0 });

  switch (state.phase) {
    case "stopping":
      if (!input.anyAlive) return { state: advance("done"), action: "complete" };
      if (state.phaseElapsedMs >= tuning.gracefulTimeoutMs) {
        return { state: advance("force-term"), action: "sigterm" };
      }
      return { state: { ...state, phaseElapsedMs: state.phaseElapsedMs + POLL_MS }, action: "wait" };
    case "force-term":
      if (!input.anyAlive) return { state: advance("done"), action: "complete" };
      if (state.phaseElapsedMs >= tuning.termTimeoutMs) {
        return { state: advance("force-kill"), action: "sigkill" };
      }
      return { state: { ...state, phaseElapsedMs: state.phaseElapsedMs + POLL_MS }, action: "wait" };
    case "force-kill":
      if (!input.anyAlive) return { state: advance("done"), action: "complete" };
      if (state.phaseElapsedMs >= tuning.termTimeoutMs) {
        return { state: advance("done"), action: "incomplete" };
      }
      return { state: { ...state, phaseElapsedMs: state.phaseElapsedMs + POLL_MS }, action: "wait" };
    case "done":
      return { state, action: "complete" };
  }
}

export const POLL_MS = 500;

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  lstart: string;
  command: string;
}

/** Parse ps metadata; normalize its padded day-of-month field. */
export function parsePsTable(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      lstart: match[4].replace(/\s+/g, " "), command: match[5] });
  }
  return rows;
}

export async function readPidFile(fs: { readFile: typeof readFile }, file: string): Promise<number | null> {
  try {
    const text = (await fs.readFile(file, "utf8")).trim();
    const pid = Number(text);
    return /^\d+$/.test(text) && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface ShutdownDeps {
  scope: ComputerProcessScope;
  snapshot(): Promise<ComputerProcessSnapshot>;
  requestStop(): Promise<void>;
  signal(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  logFile: string;
  systemShutdown: boolean;
  tuning?: ShutdownTuning;
  /** Additional bounded window for pidfile and host-lifecycle finalization. */
  stopFinishTimeoutMs?: number;
}

/** Retain descendants even after the service clears pidfiles. Stop runs in
 * parallel so a slow stop never holds up escalation. Re-read identity before
 * every signal; unknown identity is a reason to report incomplete, not kill. */
export async function runShutdownTree(deps: ShutdownDeps): Promise<boolean> {
  const tuning = deps.tuning ?? tuningFor(deps.systemShutdown);
  const log = async (line: string) => {
    try { await appendFile(deps.logFile, `${new Date(deps.now()).toISOString()} ${line}\n`); } catch { /* best effort */ }
  };
  const first = await deps.snapshot();
  deps.scope.assertRoots(first);
  deps.scope.observe(first);
  const startStop = () => {
    const outcome: { status: "pending" | "success" | "failed"; error?: unknown } = { status: "pending" };
    const task = Promise.resolve().then(() => deps.requestStop()).then(
      () => { outcome.status = "success"; },
      (error: unknown) => { outcome.status = "failed"; outcome.error = error; },
    );
    return { outcome, task };
  };
  const stop = startStop();
  const finishStop = async (): Promise<boolean> => {
    const wait = async (attempt: ReturnType<typeof startStop>): Promise<boolean> => {
      const deadline = deps.now() + (deps.stopFinishTimeoutMs ?? (deps.systemShutdown ? 3_000 : 5_000));
      while (attempt.outcome.status === "pending") {
        const remaining = deadline - deps.now();
        if (remaining <= 0) {
          await log("shutdown INCOMPLETE: stop finalization timed out");
          return false;
        }
        await deps.sleep(Math.min(POLL_MS, remaining));
      }
      await attempt.task;
      return true;
    };
    if (!(await wait(stop))) return false;
    let finished = stop;
    if (stop.outcome.status === "failed" && (stop.outcome.error as { code?: string } | null)?.code === "STOP_TIMEOUT") {
      // A timed-out polite stop may have been followed by verified force-kill.
      // With an empty tree, retry the idempotent stop to finish pidfiles and
      // login ownership. Never skip those mutations just because PIDs vanished.
      await log("stop timed out before all-clear; retrying lifecycle finalization");
      finished = startStop();
      if (!(await wait(finished))) return false;
    }
    if (finished.outcome.status !== "success") {
      await log(`shutdown INCOMPLETE: stop failed: ${finished.outcome.error instanceof Error ? finished.outcome.error.message : "unknown error"}`);
      return false;
    }
    return true;
  };
  let state: ShutdownState = { phase: "stopping", phaseElapsedMs: 0 };
  let phaseStarted = deps.now();
  for (let guard = 0; guard < 200; guard++) {
    const snapshot = await deps.snapshot();
    const survivors = deps.scope.observe(snapshot);
    const unresolved = deps.scope.unverified(snapshot);
    const step = nextShutdownAction({ state: { ...state, phaseElapsedMs: deps.now() - phaseStarted },
      tuning, anyAlive: survivors.length + unresolved.length > 0 });
    if (step.state.phase !== state.phase) phaseStarted = deps.now();
    state = step.state;
    if (step.action === "sigterm" || step.action === "sigkill") {
      const signal = step.action === "sigterm" ? "SIGTERM" : "SIGKILL";
      await log(`${step.action}: verified=[${survivors.map((row) => row.pid)}] unverified=[${unresolved}]`);
      // Descendants first: do not destroy the service before its children have
      // received the same signal. Positive PIDs only, including detached tools.
      for (const expected of [...survivors].reverse()) {
        const fresh = await deps.snapshot();
        const current = fresh.rows.find((row) => row.pid === expected.pid);
        if (!deps.scope.matches(expected, current)) continue;
        try { deps.signal(expected.pid, signal); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") await log(`signal failed: pid=${expected.pid}`);
        }
      }
    } else if (step.action === "complete") {
      if (!(await finishStop())) return false;
      // Finalization can await external lifecycle work: re-check for processes
      // born in that window before releasing the app's quit gate.
      const last = await deps.snapshot();
      if (deps.scope.observe(last).length + deps.scope.unverified(last).length > 0) {
        await log("shutdown INCOMPLETE: processes appeared during stop finalization");
        return false;
      }
      await log("shutdown complete: processes cleared and stop finalized");
      return true;
    } else if (step.action === "incomplete") {
      await log(`shutdown INCOMPLETE: remaining=[${[...survivors.map((row) => row.pid), ...unresolved]}]`);
      return false;
    }
    await deps.sleep(POLL_MS);
  }
  await log("shutdown INCOMPLETE: ladder exhausted");
  return false;
}
