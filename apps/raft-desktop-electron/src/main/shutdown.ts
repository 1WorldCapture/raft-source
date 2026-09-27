// Quit-stops-everything orchestration (task #7): when the user really quits,
// every local background process must be gone before the GUI exits — the
// service supervisor, the per-server runner daemons, AND the agent runtimes
// they spawned (claude/codex children). Agents live in the runners' process
// groups, so the escalation path signals whole groups (kill(-pgid)), never a
// bare pid: SIGKILLing only the runner would orphan the agents to launchd and
// keep them running — exactly the risk this task exists to close.
//
// The phase transition is a pure function (unit-tested); `runShutdownTree`
// wires it to pidfile liveness, an agent-runtime scan, and the group signals.
import { appendFile, readFile } from "node:fs/promises";

export type ShutdownPhase = "stopping" | "force-term" | "force-kill" | "done";

export type ShutdownAction = "wait" | "poll" | "sigterm-group" | "sigkill-group" | "complete";

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
 *    without polling survivors yet (the tree is shutting down by design).
 *  - stopping also keeps checking liveness every tick: everything gone early
 *    → complete without escalating.
 *  - force-term / force-kill: signal every surviving group, then wait the
 *    window for that phase; still alive → escalate; gone → complete.
 */
export function nextShutdownAction(input: {
  state: ShutdownState;
  tuning: ShutdownTuning;
  serviceAlive: boolean;
  runnerAlive: boolean;
  agentAlive: boolean;
}): { state: ShutdownState; action: ShutdownAction } {
  const { state, tuning } = input;
  const anyAlive = input.serviceAlive || input.runnerAlive || input.agentAlive;
  const advance = (phase: ShutdownPhase): ShutdownState => ({ phase, phaseElapsedMs: 0 });

  switch (state.phase) {
    case "stopping":
      if (!anyAlive) return { state: advance("done"), action: "complete" };
      if (state.phaseElapsedMs >= tuning.gracefulTimeoutMs) {
        return { state: advance("force-term"), action: "sigterm-group" };
      }
      return { state: { ...state, phaseElapsedMs: state.phaseElapsedMs + POLL_MS }, action: "wait" };
    case "force-term":
    case "force-kill":
      if (!anyAlive) return { state: advance("done"), action: "complete" };
      if (state.phaseElapsedMs >= tuning.termTimeoutMs) {
        return state.phase === "force-term"
          ? { state: advance("force-kill"), action: "sigkill-group" }
          : { state: advance("done"), action: "complete" }; // kill refused to die; report via log
      }
      return { state: { ...state, phaseElapsedMs: state.phaseElapsedMs + POLL_MS }, action: "wait" };
    case "done":
      return { state, action: "complete" };
  }
}

export const POLL_MS = 500;

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

/**
 * Identify leftover agent-runtime processes from a raw `ps axo pid=,command=`
 * dump. Agents are Electron-daemon children with SLOCK_AGENT_ID in their
 * environment — not visible in ps output — but their command lines embed the
 * agent workspace path (~/.slock/agents/<id>), which is unique to them.
 * Pure so tests can feed synthetic dumps.
 */
export function scanAgentPids(psOutput: string, agentsDir: string): number[] {
  const marker = agentsDir.endsWith("/") ? agentsDir : `${agentsDir}/`;
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes(marker)) continue;
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

// ─── orchestration runner ────────────────────────────────────────────────────

export interface ShutdownDeps {
  slockHome: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Signal a whole process group; falls back to the bare pid. */
  signal(pgidOrPid: number, signal: NodeJS.Signals): void;
  /** Signal every survivor group for the current escalation step. */
  survivors(): Promise<{ servicePid: number | null; runnerPids: number[]; agentPids: number[] }>;
  logFile: string;
  systemShutdown: boolean;
}

/**
 * Drive the tree to full exit: one IPC stop (already issued by the caller),
 * then the state machine's escalation ladder. Writes a timeline to the log
 * file; resolves once every process is gone or the ladder is exhausted.
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
  while (state.phase !== "done" && guard++ < 200) {
    const alive = await deps.survivors();
    const step = nextShutdownAction({
      state,
      tuning,
      serviceAlive: alive.servicePid !== null,
      runnerAlive: alive.runnerPids.length > 0,
      agentAlive: alive.agentPids.length > 0,
    });
    state = step.state;
    if (step.action === "sigterm-group" || step.action === "sigkill-group") {
      const signal: NodeJS.Signals = step.action === "sigterm-group" ? "SIGTERM" : "SIGKILL";
      await log(`${step.action}: service=${alive.servicePid} runners=[${alive.runnerPids}] agents=[${alive.agentPids}]`);
      for (const pid of [alive.servicePid, ...alive.runnerPids, ...alive.agentPids]) {
        if (pid) deps.signal(pid, signal);
      }
    } else if (step.action === "complete") {
      await log("shutdown complete: no raft processes remain");
      return;
    }
    await deps.sleep(POLL_MS);
  }
  if (state.phase !== "done") await log("shutdown ladder exhausted without full exit — reporting");
}
