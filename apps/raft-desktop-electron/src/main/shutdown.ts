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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  /** Process start time (`ps lstart=`, 7 words). Roots carry an expected
   * lstart so a REUSED pid can never pass as a live root. */
  lstart: string;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,pgid=,lstart=,command=` output. Pure. */
export function parsePsTable(psOutput: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of psOutput.split("\n")) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), lstart: match[4], command: match[5] });
  }
  return rows;
}

export interface TreeSurvivors {
  /** Everything Raft owns: live-root descendants/groups + verified orphans. */
  pids: number[];
  /** Root pids that are still alive. */
  roots: number[];
  /** Live-root process groups — escalation targets for kill(-pgid). */
  groups: number[];
  /** Orphans of DEAD roots, individually verified as Raft's. Signal these
   * one pid at a time — never by group: the dead root's pgid may by now be
   * reused by an unrelated process. */
  orphanPids: number[];
}

/**
 * Pure planning step. From the trusted pidfile roots and a parsed ps table:
 *  - the descendant closure runs from the LIVE roots only — a dead root's
 *    pid may already be reused by an unrelated process, and orphans are
 *    re-parented to launchd (ppid 1) anyway, so a dead-root closure would
 *    find nothing real and could match a stranger's subtree;
 *  - group members are processes in a LIVE root's pgid;
 *  - candidates for dead roots' orphaned agents: `pgid` equals a dead root's
 *    pid AND `ppid === 1` (post-adoption shape). Each candidate still needs
 *    an out-of-band Raft identity check (see resolveSurvivors) before it
 *    counts — group id alone is not ownership.
 * The user's own processes are never descendants of our roots, never in our
 * groups, and never carry our identity markers.
 */
export function collectSurvivorPlan(
  rows: ReadonlyArray<PsRow>,
  rootPids: ReadonlyArray<number>,
  expectedRootLstart?: ReadonlyMap<number, string>,
): { owned: number[]; liveRoots: number[]; groups: number[]; orphanCandidates: PsRow[] } {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const rootSet = new Set(rootPids);
  // A root is LIVE only when its pid exists in the table AND — when we have
  // recorded a start time for it — that time still matches. Without the
  // lstart check, a pid that died and got reused by an unrelated process
  // would pass as a live root and drag the stranger's whole subtree into
  // the kill set.
  const isLiveRoot = (pid: number): boolean => {
    const row = byPid.get(pid);
    if (!row) return false;
    const expected = expectedRootLstart?.get(pid);
    return expected === undefined || expected === row.lstart;
  };
  const liveRoots = rootPids.filter(isLiveRoot);
  const deadRootPids = rootPids.filter((pid) => !liveRoots.includes(pid));
  const rootGroups = new Set(liveRoots.map((pid) => byPid.get(pid)!.pgid));
  // Descendant closure from LIVE roots only.
  const owned = new Set<number>(liveRoots);
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
  // Dead-root orphan candidates: adopted by launchd, still in the dead
  // root's process group.
  const orphanCandidates = rows.filter(
    (row) => !owned.has(row.pid) && row.ppid === 1 && deadRootPids.includes(row.pgid),
  );
  return { owned: [...owned], liveRoots, groups: [...rootGroups], orphanCandidates };
}

/**
 * Full survivor resolution: plan (pure) + identity verification of the
 * dead-root orphan candidates. A candidate counts only when the verifier
 * recognizes it as ours — by default `ps eww` shows the process environment,
 * where every Raft-managed agent runtime carries SLOCK_AGENT_ID. When the
 * environment cannot be read, the candidate is skipped (fail-closed on the
 * kill decision): better to leave one pid for the acceptance check to catch
 * than to kill a stranger that happened into a recycled pgid.
 */
export async function resolveSurvivors(
  rows: ReadonlyArray<PsRow>,
  rootPids: ReadonlyArray<number>,
  verifyOrphan?: (row: PsRow) => Promise<boolean>,
  expectedRootLstart?: ReadonlyMap<number, string>,
  raftHome?: string,
): Promise<TreeSurvivors> {
  const verify = verifyOrphan ?? ((row: PsRow) => defaultVerifyOrphan(row, raftHome));
  const plan = collectSurvivorPlan(rows, rootPids, expectedRootLstart);
  const orphanPids: number[] = [];
  for (const candidate of plan.orphanCandidates) {
    let isOurs = false;
    try {
      isOurs = await verify(candidate);
    } catch {
      isOurs = false; // unreadable → not verified → not a target
    }
    if (isOurs) orphanPids.push(candidate.pid);
  }
  return {
    pids: [...plan.owned, ...orphanPids],
    roots: plan.liveRoots,
    groups: plan.groups,
    orphanPids,
  };
}

/**
 * Prove a `ps eww -o command=` line (command + environment, space-separated)
 * belongs to the given Raft state root. Accepted evidence, matching how the
 * service tree is spawned:
 *  - an explicit `RAFT_HOME=<root>` / `SLOCK_HOME=<root>` environment
 *    assignment (the service exports its root to `__run` children), or
 *  - a `--slock-home <root>` argv (the `__service` dispatcher form).
 * The value must end at whitespace/EOL so `.slock` never matches `.slock-x`.
 * Lines with NO root marker (processes from older builds, or the user's own
 * editor/tail inside a root's agents dir) fail closed: not ours.
 */
export function psLineBelongsToRaftHome(line: string, raftHome: string): boolean {
  const escaped = raftHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const env = new RegExp(`(?:^|\\s)(?:RAFT_HOME|SLOCK_HOME)=${escaped}(?=\\s|$)`);
  if (env.test(line)) return true;
  const argv = new RegExp(`(?:^|\\s)--slock-home\\s+${escaped}(?=\\s|$)`);
  return argv.test(line);
}

/** Default identity check: SLOCK_AGENT_ID in the process environment
 * (`ps eww` prints the environment after the command). Unreadable → false.
 *
 * With `raftHome`, the check is root-scoped: SLOCK_AGENT_ID alone matches
 * agents of EVERY Raft state root on the machine, so the 2026-10-02 incident
 * had a desktop quit-ladder claim (and kill) a sibling root's agents as
 * "ours". The line must ALSO prove binding to this app's root.
 */
export async function defaultVerifyOrphan(row: PsRow, raftHome?: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["eww", "-o", "command=", "-p", String(row.pid)]);
    if (!stdout.includes("SLOCK_AGENT_ID=")) return false;
    if (raftHome === undefined) return true;
    return psLineBelongsToRaftHome(stdout, raftHome);
  } catch {
    return false;
  }
}

/**
 * Filter trusted pidfile roots down to the ones whose live process proves it
 * belongs to `raftHome` (see psLineBelongsToRaftHome). A root that cannot be
 * proven ours — a recycled pid, an unmarked legacy process, or a service of
 * ANOTHER state root sharing this machine — is dropped and reported through
 * `onForeign`, never signalled. This is the hard boundary that keeps the
 * quit ladder inside the state root this app was built to manage.
 */
export async function filterRootsByRaftHome(
  rootPids: ReadonlyArray<number>,
  raftHome: string,
  deps: {
    ps?: (pid: number) => Promise<string>;
    onForeign?: (pid: number, reason: string) => void;
  } = {},
): Promise<number[]> {
  const ps = deps.ps ?? ((pid: number) =>
    execFileAsync("ps", ["eww", "-o", "command=", "-p", String(pid)]).then((r) => r.stdout));
  const verified: number[] = [];
  for (const pid of rootPids) {
    let line: string;
    try {
      line = await ps(pid);
    } catch {
      // ps cannot see it → the pid is gone; not a root for the ladder.
      deps.onForeign?.(pid, "ps-unreachable");
      continue;
    }
    if (psLineBelongsToRaftHome(line, raftHome)) {
      verified.push(pid);
    } else {
      deps.onForeign?.(pid, "not-bound-to-" + raftHome);
    }
  }
  return verified;
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
  /** Identity check for dead-root orphan candidates (default: ps eww env). */
  verifyOrphan?: (row: PsRow) => Promise<boolean>;
  logFile: string;
  systemShutdown: boolean;
}

/**
 * Drive the tree to full exit: one IPC stop (already issued by the caller),
 * then the state machine's escalation ladder. Writes a timeline to the log
 * file; resolves once every owned process is gone, or reports the stragglers
 * when even SIGKILL did not clear them.
 *
 * Root-identity pinning: the first tick records every root's lstart from the
 * ps table; later ticks treat a root as live only when the recorded time
 * still matches. A root that dies mid-ladder and has its pid reused by a
 * stranger therefore degrades to a DEAD root — its "children" can never be
 * matched via ppid (orphans are re-parented to 1 anyway) and the recycled
 * pgid is never signaled.
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
  const pinnedRootLstart = new Map<number, string>();
  while (state.phase !== "done" && guard++ < 200) {
    const { rootPids, psTable } = await deps.survivors();
    const rows = parsePsTable(psTable);
    for (const root of rootPids) {
      if (!pinnedRootLstart.has(root)) {
        const row = rows.find((candidate) => candidate.pid === root);
        if (row) pinnedRootLstart.set(root, row.lstart);
      }
    }
    const survivors = await resolveSurvivors(rows, rootPids, deps.verifyOrphan, pinnedRootLstart);
    lastSurvivorPids = survivors.pids;
    const step = nextShutdownAction({
      state,
      tuning,
      anyAlive: survivors.pids.length > 0,
    });
    state = step.state;
    if (step.action === "sigterm-group" || step.action === "sigkill-group") {
      const signal: NodeJS.Signals = step.action === "sigterm-group" ? "SIGTERM" : "SIGKILL";
      await log(`${step.action}: roots=[${survivors.roots}] groups=[${survivors.groups}] orphans=[${survivors.orphanPids}] pids=[${survivors.pids}]`);
      // Groups first (one signal covers the whole group), then every owned
      // pid individually — verified orphans are signaled by pid only, never
      // by their recycled dead-root pgid.
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
