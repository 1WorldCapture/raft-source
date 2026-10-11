import { execFileSync } from "node:child_process";

/**
 * Restart-caller classification for `raft-computer restart` (upstream task
 * #829/#1202 final shape, review round 2).
 *
 * A restart asked for from a person's own terminal is a stop followed by a
 * start from that terminal (runCallerStopThenStart in cli.ts). A caller that
 * runs inside an agent hosted by this machine must NOT stop the service —
 * stopping it tears down the caller's own runtime — so for those the restart
 * stays an IPC handoff where the old service launches its own replacement.
 *
 * Two positive signals, and doubt falls back to the handoff:
 *
 *  1. SLOCK_AGENT_ID — set by the daemon on every child-process agent it
 *     spawns (see agentProcessManager). Definitive for that lane.
 *  2. The caller is a DESCENDANT of the live service pid. In-process SDK
 *     drivers (pi, kimi-sdk) execute their bash tools with the daemon
 *     process's own env — no agent marker there — but the CLI they invoke is
 *     still a descendant of the service, and the walk proves it.
 *
 * If the ancestor walk cannot run (ps missing/fails, pid unknown), treat the
 * caller as POSSIBLY runner-hosted: the IPC handoff is always safe (it never
 * stops anything from the caller), while a wrong stop-then-start leaves the
 * machine stopped with the caller dead — the exact failure this guards.
 */

/** Set by the daemon on every agent child it spawns; see agentProcessManager. */
export const RUNNER_HOSTED_AGENT_ENV_VAR = "SLOCK_AGENT_ID";

/** Max ancestor hops before giving up (guards pid-recycling cycles). */
const MAX_ANCESTOR_HOPS = 64;

/**
 * The caller's parent pid: a positive number, or null when the pid IS the
 * root of its tree (no parent — ps answers ppid 0/empty). THROWS when the
 * read itself fails (ps missing, permission, race): a failed read is doubt,
 * a root is proof, and the classification below depends on that difference.
 */
export function readParentPidForTests(pid: number): number | null {
  const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  }).trim();
  const ppid = Number.parseInt(out, 10);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

let readParentPid: (pid: number) => number | null = readParentPidForTests;

/** Test seam: inject the ppid reader (no real process tree in tests). */
export function setParentPidReaderForTests(reader: ((pid: number) => number | null) | null): void {
  readParentPid = reader ?? readParentPidForTests;
}

export interface CallerRunnerHostedProbe {
  /** The live service pid, when one is running (used by the ancestor walk). */
  servicePid?: number | null;
  /** The caller's own pid (defaults to process.pid). */
  selfPid?: number;
}

/**
 * True  → the caller is (or may be) an agent hosted by this machine's
 * service: restart must go through the IPC handoff.
 * False → only when the caller is POSITIVELY identified as a person's
 * terminal (no agent marker AND provably not a service descendant).
 */
export function callerIsRunnerHosted(
  env: NodeJS.ProcessEnv = process.env,
  probe: CallerRunnerHostedProbe = {},
): boolean {
  const marker = env[RUNNER_HOSTED_AGENT_ENV_VAR];
  if (typeof marker === "string" && marker.length > 0) return true;
  const servicePid = probe.servicePid ?? null;
  if (servicePid == null || !Number.isInteger(servicePid) || servicePid <= 0) {
    // No live service: nothing to be a descendant of. The plain-env caller
    // reaching a no-service restart is a person (or a cold-boot script).
    return false;
  }
  const selfPid = probe.selfPid ?? process.pid;
  let current: number | null = selfPid;
  try {
    for (let hop = 0; current != null && hop < MAX_ANCESTOR_HOPS; hop += 1) {
      if (current === servicePid) return true;
      current = readParentPid(current);
    }
  } catch {
    // The tree is unreadable: assume hosted (the handoff is always safe; a
    // wrong stop from a hosted agent is not).
    return true;
  }
  if (current == null) {
    // Reached the tree's root without meeting the service: PROVEN not a
    // descendant — a person's terminal.
    return false;
  }
  // MAX_ANCESTOR_HOPS exhausted (pid-recycling cycle or absurd depth):
  // doubt, assume hosted.
  return true;
}
