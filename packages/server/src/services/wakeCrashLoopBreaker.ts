/**
 * Server-side crash-loop breaker for automatic agent wakes (upstream 1.21.2
 * port, their task #1119; incident 2026-09-14: a runner died on every start
 * and the server woke it again on every reconnect for 181 cycles).
 *
 * PM requirements folded into the port:
 *  - thresholds/window are env-configurable with CONSERVATIVE defaults — a
 *    false trip locks a normal agent out of automatic wakes, so missing the
 *    trip is preferable to a false one (`resolveWakeCrashLoopRules`);
 *  - a tripped block has explicit release paths: human start/resume
 *    (recordStart human), manual stop, runtime config change
 *    (liftForConfigChange), and a time cooldown (WAKE_CRASH_LOOP_BLOCK_COOLDOWN_MS,
 *    checked in isBlocked) — so an agent that won't wake shows "circuit
 *    breaker tripped" in its status instead of looking like a silent bug.
 *
 * Counting rule (locked upstream in #proj-runtime:3ddaa7c2):
 *  - an "early exit" is a daemon-reported *process exit* observed within
 *    windowMs of that start; at most one early exit per start;
 *  - a machine disconnect, an exit without evidence, or an exit whose
 *    launchId does not match the current start is NOT counted;
 *  - THRESHOLD consecutive early exits block automatic wakes for the episode;
 *  - a start that runs past windowMs without an exit resets the count;
 *  - manual stop forgets the streak; only a human start/resume lifts a block,
 *    and it opens a new episode.
 *
 * 取舍 (departure from upstream): their daemon attaches exit code/signal
 * evidence to `agent:status inactive`; ours carries only (status, launchId).
 * The orchestrator therefore supplies synthetic evidence for a matching-
 * launch inactive frame — a start that reports inactive before surviving the
 * window demonstrably did not survive — and rejects frames without a
 * launchId. Rules stay conservative (3 in 60s) to absorb the weaker signal.
 *
 * State lives in the replica state store behind an optimistic compare-and-set
 * so a block survives a replica switch. The pure transition functions are
 * exported so the rules stay testable without a store.
 */
import type { WakeCrashLoopActivityDiagnostic } from "@botiverse/raft-shared";

export type { WakeCrashLoopActivityDiagnostic };

export const WAKE_CRASH_LOOP_WINDOW_MS = 60_000;
export const WAKE_CRASH_LOOP_THRESHOLD = 3;
/** A tripped block lifts itself after this cooldown even without a human act. */
export const WAKE_CRASH_LOOP_BLOCK_COOLDOWN_MS = 30 * 60_000;

function readPositiveIntEnvFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export interface WakeCrashLoopRules {
  windowMs: number;
  threshold: number;
  /** 0 disables the time-cooldown release (a block then needs a human/config act). */
  blockCooldownMs: number;
}

/** Env-configurable rules; defaults stay conservative per PM's note. */
export function resolveWakeCrashLoopRules(env: NodeJS.ProcessEnv = process.env): WakeCrashLoopRules {
  return {
    windowMs: readPositiveIntEnvFrom(env, "WAKE_CRASH_LOOP_WINDOW_MS", WAKE_CRASH_LOOP_WINDOW_MS),
    threshold: readPositiveIntEnvFrom(env, "WAKE_CRASH_LOOP_THRESHOLD", WAKE_CRASH_LOOP_THRESHOLD),
    blockCooldownMs: readPositiveIntEnvFrom(env, "WAKE_CRASH_LOOP_BLOCK_COOLDOWN_MS", WAKE_CRASH_LOOP_BLOCK_COOLDOWN_MS),
  };
}

export const DEFAULT_WAKE_CRASH_LOOP_RULES: WakeCrashLoopRules = resolveWakeCrashLoopRules();

export type WakeCrashLoopExitKind = WakeCrashLoopActivityDiagnostic["lastExitKind"];

/** How the process ended, as attached by the daemon to `agent:status inactive`. */
export interface WakeCrashLoopExitEvidence {
  code: number | null;
  signal: string | null;
}

export interface WakeCrashLoopExit {
  kind: WakeCrashLoopExitKind;
  /** Daemon exit evidence; `null` when the frame carried none (then the exit is not counted). */
  evidence: WakeCrashLoopExitEvidence | null;
  /** launchId of the run that ended; must match the current start to count. */
  launchId: string | null;
}

export type WakeCrashLoopExitRejectReason =
  | "not_process_exit"
  | "no_exit_evidence"
  | "launch_mismatch"
  | "no_start"
  | "outside_window"
  | "already_counted"
  | "already_blocked";

export interface WakeCrashLoopExitObservation {
  /** False when the exit was not eligible (see `rejected`). */
  counted: boolean;
  rejected: WakeCrashLoopExitRejectReason | null;
  /** True exactly once per episode: this exit crossed the threshold. */
  blockedNow: boolean;
  snapshot: WakeCrashLoopActivityDiagnostic;
}

/** Persisted per-agent episode state. Plain JSON: ids, counts, classes, times. */
export interface WakeCrashLoopEpisodeState {
  episode: number;
  earlyExitCount: number;
  blocked: boolean;
  blockedAtMs: number | null;
  lastStartAtMs: number | null;
  lastStartLaunchId: string | null;
  lastStartCounted: boolean;
  firstExitAtMs: number | null;
  lastExitAtMs: number | null;
  lastExitKind: WakeCrashLoopExitKind | null;
  lastSignal: string | null;
  lastLaunchId: string | null;
  /** Set when the block came from a start failure retrying cannot fix. */
  needsActionReason?: string | null;
  /** Unread catch-up owed to a start refused while blocked. */
  catchupOwed?: boolean;
  /** The start (launchId) that carried the owed catch-up, pending its active report. */
  catchupCarriedLaunchId?: string | null;
}

export interface WakeCrashLoopStateRecord {
  state: WakeCrashLoopEpisodeState;
  version: number;
}

export interface WakeCrashLoopStateStore {
  getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null>;
  compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean>;
}

export interface WakeCrashLoopStartRecord {
  launchId: string | null;
  nowMs: number;
  previous: WakeCrashLoopEpisodeState;
}

export function freshWakeCrashLoopEpisode(episode: number): WakeCrashLoopEpisodeState {
  return {
    episode,
    earlyExitCount: 0,
    blocked: false,
    blockedAtMs: null,
    lastStartAtMs: null,
    lastStartLaunchId: null,
    lastStartCounted: false,
    firstExitAtMs: null,
    lastExitAtMs: null,
    lastExitKind: null,
    lastSignal: null,
    lastLaunchId: null,
  };
}

/**
 * A start was dispatched. `human` starts (manual start / resume) always lift a
 * block and open a new episode; automatic starts keep the episode. A start
 * whose predecessor ran past the window without an exit resets the count.
 */
export function applyWakeCrashLoopStart(
  current: WakeCrashLoopEpisodeState,
  input: { launchId: string | null; nowMs: number; human: boolean },
  rules: Pick<WakeCrashLoopRules, "windowMs"> = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopEpisodeState {
  let state: WakeCrashLoopEpisodeState = { ...current };
  if (input.human && (state.blocked || state.earlyExitCount > 0)) {
    // A new episode, but an owed catch-up survives until it is delivered.
    state = { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: current.catchupOwed === true };
  } else if (
    state.lastStartAtMs !== null
    && !state.lastStartCounted
    && input.nowMs - state.lastStartAtMs > rules.windowMs
  ) {
    // The previous run survived the window: the streak is broken.
    state.earlyExitCount = 0;
    state.firstExitAtMs = null;
  }
  state.lastStartAtMs = input.nowMs;
  state.lastStartLaunchId = input.launchId;
  state.lastStartCounted = false;
  // A new start supersedes any earlier carrier; the owed catch-up stays until delivered.
  state.catchupCarriedLaunchId = null;
  return state;
}

/** Human said stop: the agent is offline by intent; forget the streak but keep the episode number. */
export function applyWakeCrashLoopManualStop(current: WakeCrashLoopEpisodeState): WakeCrashLoopEpisodeState {
  return { ...freshWakeCrashLoopEpisode(current.episode), catchupOwed: current.catchupOwed === true, catchupCarriedLaunchId: null };
}

export function wakeCrashLoopExitRejectReason(
  state: WakeCrashLoopEpisodeState,
  exit: WakeCrashLoopExit,
  nowMs: number,
  rules: Pick<WakeCrashLoopRules, "windowMs"> = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopExitRejectReason | null {
  if (exit.kind !== "agent_process_exited") return "not_process_exit";
  if (!exit.evidence) return "no_exit_evidence";
  if (state.lastStartAtMs === null || state.lastStartLaunchId === null) return "no_start";
  if (exit.launchId === null || exit.launchId !== state.lastStartLaunchId) return "launch_mismatch";
  if (state.blocked) return "already_blocked";
  if (state.lastStartCounted) return "already_counted";
  if (nowMs - state.lastStartAtMs > rules.windowMs) return "outside_window";
  return null;
}

export function applyWakeCrashLoopExit(
  current: WakeCrashLoopEpisodeState,
  exit: WakeCrashLoopExit,
  nowMs: number,
  rules: Pick<WakeCrashLoopRules, "windowMs" | "threshold"> = DEFAULT_WAKE_CRASH_LOOP_RULES,
): { state: WakeCrashLoopEpisodeState; counted: boolean; rejected: WakeCrashLoopExitRejectReason | null; blockedNow: boolean } {
  const rejected = wakeCrashLoopExitRejectReason(current, exit, nowMs, rules);
  if (rejected) return { state: current, counted: false, rejected, blockedNow: false };
  const state: WakeCrashLoopEpisodeState = { ...current };
  state.lastStartCounted = true;
  state.earlyExitCount += 1;
  state.firstExitAtMs ??= nowMs;
  state.lastExitAtMs = nowMs;
  state.lastExitKind = exit.kind;
  state.lastSignal = exit.evidence?.signal ?? null;
  state.lastLaunchId = exit.launchId;
  const blockedNow = state.earlyExitCount >= rules.threshold;
  if (blockedNow) {
    state.blocked = true;
    state.blockedAtMs = nowMs;
  }
  return { state, counted: true, rejected: null, blockedNow };
}

/**
 * A start failed for a reason retrying cannot fix. Block automatic wakes at
 * once (no threshold), but only when the failure belongs to the current
 * start: a late failure from an older launch must not re-block a start a
 * person or a config change has since made. Already blocked: no change.
 */
export function applyWakeCrashLoopNonRetryableStartFailure(
  current: WakeCrashLoopEpisodeState,
  input: { launchId: string | null; reason: string; nowMs: number },
): { state: WakeCrashLoopEpisodeState; blockedNow: boolean } {
  if (current.blocked) return { state: current, blockedNow: false };
  if (input.launchId === null || input.launchId !== current.lastStartLaunchId) return { state: current, blockedNow: false };
  return {
    state: {
      ...current,
      blocked: true,
      blockedAtMs: input.nowMs,
      lastLaunchId: input.launchId,
      needsActionReason: input.reason,
      catchupOwed: true,
    },
    blockedNow: true,
  };
}

const WAKE_CRASH_LOOP_EXIT_KINDS: ReadonlySet<string> = new Set(["machine_disconnected", "agent_process_exited"]);
const MAX_WAKE_CRASH_LOOP_ID_LENGTH = 128;

function isNullableNonNegativeInt(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isNullableBoundedString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= MAX_WAKE_CRASH_LOOP_ID_LENGTH);
}

/**
 * Shape-validate a mirrored breaker carrier. Anything that is not exactly the
 * typed diagnostic (ids, counts, classes, times) is dropped, never propagated.
 */
export function normalizeWakeCrashLoopActivityDiagnostic(value: unknown): WakeCrashLoopActivityDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (!Number.isInteger(c.episode) || (c.episode as number) < 1) return null;
  if (!Number.isInteger(c.earlyExitCount) || (c.earlyExitCount as number) < 0) return null;
  if (!Number.isInteger(c.threshold) || (c.threshold as number) < 1) return null;
  if (!Number.isInteger(c.windowMs) || (c.windowMs as number) < 1) return null;
  if (typeof c.blocked !== "boolean") return null;
  if (!isNullableNonNegativeInt(c.blockedAtMs) || !isNullableNonNegativeInt(c.firstExitAtMs) || !isNullableNonNegativeInt(c.lastExitAtMs)) return null;
  if (c.lastExitKind !== null && !(typeof c.lastExitKind === "string" && WAKE_CRASH_LOOP_EXIT_KINDS.has(c.lastExitKind))) return null;
  if (!isNullableBoundedString(c.lastSignal) || !isNullableBoundedString(c.lastLaunchId)) return null;
  return {
    episode: c.episode as number,
    earlyExitCount: c.earlyExitCount as number,
    threshold: c.threshold as number,
    windowMs: c.windowMs as number,
    blocked: c.blocked,
    blockedAtMs: c.blockedAtMs,
    firstExitAtMs: c.firstExitAtMs,
    lastExitAtMs: c.lastExitAtMs,
    lastExitKind: c.lastExitKind as WakeCrashLoopExitKind | null,
    lastSignal: c.lastSignal,
    lastLaunchId: c.lastLaunchId,
  };
}

export function wakeCrashLoopSnapshot(
  state: WakeCrashLoopEpisodeState,
  rules: Pick<WakeCrashLoopRules, "windowMs" | "threshold"> = DEFAULT_WAKE_CRASH_LOOP_RULES,
): WakeCrashLoopActivityDiagnostic {
  return {
    episode: state.episode,
    earlyExitCount: state.earlyExitCount,
    threshold: rules.threshold,
    windowMs: rules.windowMs,
    blocked: state.blocked,
    blockedAtMs: state.blockedAtMs,
    firstExitAtMs: state.firstExitAtMs,
    lastExitAtMs: state.lastExitAtMs,
    lastExitKind: state.lastExitKind,
    lastSignal: state.lastSignal,
    lastLaunchId: state.lastLaunchId,
  };
}

/** Process-local store: the no-Redis (single replica) fallback and the unit-test default. */
export class InMemoryWakeCrashLoopStateStore implements WakeCrashLoopStateStore {
  private readonly records = new Map<string, WakeCrashLoopStateRecord>();

  async getWakeCrashLoopState(agentId: string): Promise<WakeCrashLoopStateRecord | null> {
    return this.getWakeCrashLoopStateSync(agentId);
  }

  async compareAndSetWakeCrashLoopState(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): Promise<boolean> {
    return this.compareAndSetWakeCrashLoopStateSync(agentId, expectedVersion, state);
  }

  getWakeCrashLoopStateSync(agentId: string): WakeCrashLoopStateRecord | null {
    const record = this.records.get(agentId);
    return record ? { state: { ...record.state }, version: record.version } : null;
  }

  compareAndSetWakeCrashLoopStateSync(agentId: string, expectedVersion: number, state: WakeCrashLoopEpisodeState): boolean {
    const current = this.records.get(agentId)?.version ?? 0;
    if (current !== expectedVersion) return false;
    this.records.set(agentId, { state: { ...state }, version: current + 1 });
    return true;
  }
}

const CAS_MAX_ATTEMPTS = 16;

export class WakeCrashLoopBreaker {
  private readonly rules: WakeCrashLoopRules;

  constructor(
    private readonly store: WakeCrashLoopStateStore = new InMemoryWakeCrashLoopStateStore(),
    options: Partial<WakeCrashLoopRules> = {},
  ) {
    this.rules = {
      windowMs: options.windowMs ?? DEFAULT_WAKE_CRASH_LOOP_RULES.windowMs,
      threshold: options.threshold ?? DEFAULT_WAKE_CRASH_LOOP_RULES.threshold,
      blockCooldownMs: options.blockCooldownMs ?? DEFAULT_WAKE_CRASH_LOOP_RULES.blockCooldownMs,
    };
  }

  getRules(): WakeCrashLoopRules {
    return { ...this.rules };
  }

  private async read(agentId: string): Promise<WakeCrashLoopStateRecord> {
    const record = await this.store.getWakeCrashLoopState(agentId);
    return record ?? { state: freshWakeCrashLoopEpisode(1), version: 0 };
  }

  /**
   * Read → transition → compare-and-set, retried on version conflict so two
   * writers (two replicas, or a start racing an exit) both land their update
   * on the latest state instead of one overwriting the other.
   */
  private async mutate<T>(
    agentId: string,
    transition: (state: WakeCrashLoopEpisodeState) => { state: WakeCrashLoopEpisodeState; result: T; write: boolean },
  ): Promise<T> {
    let last: { state: WakeCrashLoopEpisodeState; result: T } | null = null;
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      const record = await this.read(agentId);
      const next = transition(record.state);
      last = next;
      if (!next.write) return next.result;
      if (await this.store.compareAndSetWakeCrashLoopState(agentId, record.version, next.state)) return next.result;
    }
    throw new Error(`wake crash-loop state for agent ${agentId}: compare-and-set did not converge after ${CAS_MAX_ATTEMPTS} attempts`);
  }

  /**
   * True when automatic wakes are currently blocked for this agent. A block
   * whose cooldown (PM release-path requirement) has elapsed is lifted here:
   * the read treats it as unblocked and opportunistically writes a fresh
   * episode so the lift survives a replica switch.
   */
  async isBlocked(agentId: string, nowMs?: number): Promise<boolean> {
    const now = nowMs ?? Date.now();
    if (this.rules.blockCooldownMs <= 0) {
      return (await this.read(agentId)).state.blocked;
    }
    return this.mutate(agentId, (state) => {
      if (!state.blocked) return { state, result: false, write: false };
      const blockedAt = state.blockedAtMs ?? 0;
      if (now - blockedAt < this.rules.blockCooldownMs) return { state, result: true, write: false };
      // Cooldown elapsed: lift the block, keep any owed catch-up.
      return {
        state: { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: state.catchupOwed === true },
        result: false,
        write: true,
      };
    });
  }

  /** Does the next start owe the unread catch-up (see `catchupOwed`)? */
  async isCatchupOwed(agentId: string): Promise<boolean> {
    return (await this.read(agentId)).state.catchupOwed === true;
  }

  /** This start (launchId) carries the owed catch-up. */
  async markCatchupCarried(agentId: string, launchId: string): Promise<void> {
    await this.mutate(agentId, (state) => state.catchupOwed === true && state.lastStartLaunchId === launchId
      ? { state: { ...state, catchupCarriedLaunchId: launchId }, result: undefined, write: true }
      : { state, result: undefined, write: false });
  }

  /** A start reported its runtime active: if it carried the owed catch-up, clear it. */
  async confirmCatchupDelivered(agentId: string, launchId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => state.catchupOwed === true && state.catchupCarriedLaunchId === launchId
      ? { state: { ...state, catchupOwed: false, catchupCarriedLaunchId: null }, result: true, write: true }
      : { state, result: false, write: false });
  }

  /**
   * Record a dispatched start. Returns a token for `rollbackStart` so a start
   * whose send fails can be undone without disturbing a newer start.
   */
  async recordStart(agentId: string, launchId: string | null, nowMs: number, options: { human?: boolean } = {}): Promise<WakeCrashLoopStartRecord> {
    return this.mutate(agentId, (state) => ({
      state: applyWakeCrashLoopStart(state, { launchId, nowMs, human: options.human === true }, this.rules),
      result: { launchId, nowMs, previous: { ...state } },
      write: true,
    }));
  }

  /** Undo a `recordStart` whose dispatch never left this replica. */
  async rollbackStart(agentId: string, record: WakeCrashLoopStartRecord): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      const isSameStart = state.lastStartAtMs === record.nowMs
        && state.lastStartLaunchId === record.launchId
        && !state.lastStartCounted;
      return isSameStart
        ? { state: { ...record.previous }, result: true, write: true }
        : { state, result: false, write: false };
    });
  }

  async recordManualStop(agentId: string): Promise<void> {
    await this.mutate(agentId, (state) => ({
      state: applyWakeCrashLoopManualStop(state),
      result: undefined,
      write: true,
    }));
  }

  async recordExit(agentId: string, exit: WakeCrashLoopExit, nowMs: number): Promise<WakeCrashLoopExitObservation> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopExit(state, exit, nowMs, this.rules);
      return {
        state: applied.state,
        write: applied.counted,
        result: {
          counted: applied.counted,
          rejected: applied.rejected,
          blockedNow: applied.blockedNow,
          snapshot: wakeCrashLoopSnapshot(applied.state, this.rules),
        },
      };
    });
  }

  /** See `applyWakeCrashLoopNonRetryableStartFailure`. */
  async recordNonRetryableStartFailure(
    agentId: string,
    input: { launchId: string | null; reason: string; nowMs: number },
  ): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      const applied = applyWakeCrashLoopNonRetryableStartFailure(state, input);
      return { state: applied.state, result: applied.blockedNow, write: applied.blockedNow };
    });
  }

  /**
   * The agent's runtime configuration changed, so a block that retrying could
   * not lift may no longer apply. Open a fresh episode; the next wake starts
   * normally. Also drops the in-flight start's eligibility, so a failure it
   * reports after the change cannot block. A human start/resume lifts a block
   * too (recordStart).
   */
  async liftForConfigChange(agentId: string): Promise<boolean> {
    return this.mutate(agentId, (state) => {
      if (state.blocked) {
        return {
          state: { ...freshWakeCrashLoopEpisode(state.episode + 1), catchupOwed: state.catchupOwed === true },
          result: true,
          write: true,
        };
      }
      // Not blocked yet, but a start made under the old configuration may still
      // report its failure. Forget that start so its late failure cannot block
      // the agent under the new configuration.
      if (state.lastStartLaunchId === null) return { state, result: false, write: false };
      return { state: { ...state, lastStartLaunchId: null }, result: false, write: true };
    });
  }

  async snapshot(agentId: string): Promise<WakeCrashLoopActivityDiagnostic> {
    return wakeCrashLoopSnapshot((await this.read(agentId)).state, this.rules);
  }
}
