// Quit-stops-everything orchestration (task #7): when the user really quits,
// every local background process must be gone before the GUI exits — the
// service supervisor, the per-server runner daemons, AND the agent runtimes
// they spawned (claude/codex children). Survivors are identified from the
// TRUSTED pidfile roots (service.pid, runner.pid) by walking the process
// parent tree and the roots' process groups — never by pattern-matching
// command lines, which would hit the user's own editor/tail opened inside
// the ~/.slock/agents workspace. Escalation signals whole groups
// (kill(-pgid)), so an agent runtime can never be orphaned to launchd while
// its runner dies — exactly the risk this task exists to close.
//
// The phase transition is a pure function (unit-tested); `runShutdownTree`
// wires it to pidfile liveness, the ps-based tree scan, and group signals.
import { appendFile, readFile } from "node:fs/promises";

export type ShutdownPhase = "stopping" | "force-term" | "force-kill" | "done";

export type ShutdownAction = "wait" | "sigterm-group" | "sigkill-group" | "complete" | "incomplete";

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
 *  - force-term / force-kill: signal every surviving group, wait the window;
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
        return { state: advance("force-term"), action: "sigterm-group" };
      }
      return { state: { ...state, phaseElapsedMs: state.phaseElapsedMs + POLL_MS }, action: "wait" };
    case "force-term":
      if (!input.anyAlive) return { state: advance("done"), action: "complete" };
      if (state.phaseElapsedMs >= tuning.termTimeoutMs) {
        return { state: advance("force-kill"), action: "sigkill-group" };
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

// ─── ps table + trusted-root tree scan ──────────────────────────────────────

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,pgid=,command=` output. Pure. */
export function parsePsTable(psOutput: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] });
  }
  return rows;
}

export interface TreeSurvivors {
  /** Every descendant of a live root (runners' daemons, agent runtimes, …). */
  pids: number[];
  /** Root pids that are still alive. */
  roots: number[];
  /** Root process groups — escalation targets for kill(-pgid). */
  groups: number[];
}

/**
 * Given the trusted pidfile roots and a parsed ps table, collect everything
 * Raft actually owns. The descendant closure starts from the roots WHETHER
 * OR NOT a root is still alive — a dead runner's orphaned agent children are
 * exactly the stragglers the ladder exists to clear, so they must stay
 * owned. Group signals, however, only target the LIVE roots' groups: a dead
 * root's pgid may already be reused by an unrelated process. The user's own
 * processes — an editor or tail opened inside ~/.slock/agents — are NOT
 * descendants of our roots and NOT in our groups, so they can never be
 * matched. Pure.
 */
export function collectTreeSurvivors(rows: ReadonlyArray<PsRow>, rootPids: ReadonlyArray<number>): TreeSurvivors {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const rootSet = new Set(rootPids);
  const liveRoots = rootPids.filter((pid) => byPid.has(pid));
  const rootGroups = new Set(liveRoots.map((pid) => byPid.get(pid)!.pgid));
  // Descendant closure from ALL roots (live or dead — orphans stay owned).
  const owned = new Set<number>(rootSet);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (owned.has(row.pid)) continue;
      if (owned.has(row.ppid) && row.ppid !== 0) {
        owned.add(row.pid);
        grew = true;
      }
    }
  }
  // Group members: any process whose pgid is a LIVE root's pgid.
  for (const row of rows) {
    if (rootGroups.has(row.pgid)) owned.add(row.pid);
  }
  // Dead roots are gone, not survivors — keep their orphans, drop themselves.
  const survivors = [...owned].filter((pid) => byPid.has(pid));
  return { pids: survivors, roots: liveRoots, groups: [...rootGroups] };
}

// ─── liveness inputs ─────────────────────────────────────────────────────────

/** pid-alive probe that tolerates races (pid gone between read and probe). */
export function pidAlive(kill: (pid: number, sig: 0) => void, pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours
  }
}

/** Read a pidfile; null when absent/malformed (treated as not running). */
export async function readPidFile(fs: { readFile: typeof readFile }, file: string): Promise<number | null> {
  try {
    const text = (await fs.readFile(file, "utf8")).trim();
    const pid = Number.parseInt(text, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// ─── orchestration runner ────────────────────────────────────────────────────

export interface ShutdownDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Signal a whole process group; falls back to the bare pid. */
  signal(pgidOrPid: number, signal: NodeJS.Signals): void;
  /** Live roots + their owned tree, from pidfiles and the current ps table. */
  survivors(): Promise<{ rootPids: number[]; psTable: string }>;
  logFile: string;
  systemShutdown: boolean;
}

/**
 * Drive the tree to full exit: one IPC stop (already issued by the caller),
 * then the state machine's escalation ladder. Writes a timeline to the log
 * file; resolves once every owned process is gone, or reports the stragglers
 * when even SIGKILL did not clear them.
 */
export async function runShutdownTree(deps: ShutdownDeps): Promise<void> {
  const tuning = tuningFor(deps.systemShutdown);
  const log = async (line: string) => {
    const at = new Date(deps.now()).toISOString();
    try {
      await appendFile(deps.logFile, `${at} ${line}\n`);
    } catch {
      // Logging must never block the shutdown ladder.
    }
  };
  let state: ShutdownState = { phase: "stopping", phaseElapsedMs: 0 };
  let guard = 0;
  let lastSurvivorPids: number[] = [];
  while (state.phase !== "done" && guard++ < 200) {
    const { rootPids, psTable } = await deps.survivors();
    const survivors = collectTreeSurvivors(parsePsTable(psTable), rootPids);
    lastSurvivorPids = survivors.pids;
    const step = nextShutdownAction({
      state,
      tuning,
      anyAlive: survivors.pids.length > 0,
    });
    state = step.state;
    if (step.action === "sigterm-group" || step.action === "sigkill-group") {
      const signal: NodeJS.Signals = step.action === "sigterm-group" ? "SIGTERM" : "SIGKILL";
      await log(`${step.action}: roots=[${survivors.roots}] groups=[${survivors.groups}] pids=[${survivors.pids}]`);
      // Groups first (one signal covers the whole group), then any owned pid
      // that escaped into its own group.
      const targets = new Set<number>(survivors.groups);
      for (const pid of survivors.pids) targets.add(pid);
      for (const target of targets) deps.signal(target, signal);
    } else if (step.action === "complete") {
      await log("shutdown complete: no raft processes remain");
      return;
    } else if (step.action === "incomplete") {
      await log(`shutdown INCOMPLETE: could not terminate [${lastSurvivorPids}] even after SIGKILL`);
      return;
    }
    await deps.sleep(POLL_MS);
  }
  if (state.phase !== "done") await log("shutdown ladder exhausted without full exit — reporting");
}
