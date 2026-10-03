// Retry policy for tracked agent deliveries (task #8, #bugfix): the 5-second
// fixed re-send cadence turned a single unacknowledged mention into a
// quarter-hour storm (127 runner.log lines, 59 daemon coalesces) because the
// budget was per-track and exhaustion was invisible. These pure functions
// carry the decisions the orchestrator wires up:
//   - exponential backoff (5s base, doubling, capped at 5 minutes)
//   - a PERSISTENT budget: exhaustion terminal-marks the durable mention
//     occurrence (RETRY_EXHAUSTED — a server-side verdict, never a daemon
//     report) so later tracks/redrives/recoveries see a queryable terminal
//     state instead of silently starting a fresh budget
//   - generation matching: a late terminal_error may only stop the tracked
//     attempt it belongs to; an old process's error must never cancel a
//     delivery a new process has taken over.

export const AGENT_DELIVERY_ACK_TIMEOUT_BASE_MS = 5_000;
export const AGENT_DELIVERY_ACK_BACKOFF_CAP_MS = 300_000;
export const AGENT_DELIVERY_ACK_MAX_ATTEMPTS = 24;

/**
 * Backoff before the next re-send attempt: 5s, 10s, 20s, … doubling, capped
 * at 5 minutes. `attempts` is the number of sends already made.
 */
export function agentDeliveryAckBackoffMs(attempts: number): number {
  const completed = Math.max(0, Math.floor(attempts));
  if (completed <= 0) return AGENT_DELIVERY_ACK_TIMEOUT_BASE_MS;
  // 2^(completed-1) with an overflow guard: anything past the cap is the cap.
  const shift = Math.min(completed - 1, 30);
  const doubled = AGENT_DELIVERY_ACK_TIMEOUT_BASE_MS * 2 ** shift;
  return Math.min(doubled, AGENT_DELIVERY_ACK_BACKOFF_CAP_MS);
}

/**
 * Exhaustion verdict for a tracked delivery whose ack never came: the
 * durable occurrence is terminal-marked RETRY_EXHAUSTED (queryable, not
 * just a log line) before the in-memory tracker is dropped.
 */
export function agentDeliveryRetryExhaustion(attempts: number, firstAttemptAt: number, now: number): {
  code: "RETRY_EXHAUSTED";
  attempts: number;
  firstAttemptAgeMs: number;
} {
  return {
    code: "RETRY_EXHAUSTED",
    attempts,
    firstAttemptAgeMs: Math.max(0, now - firstAttemptAt),
  };
}

export interface DeliveryGeneration {
  machineId: string;
  launchId: string;
  sessionId: string;
}

/**
 * Does a late terminal_error belong to the tracked attempt it wants to stop?
 * The tracked message's own mentionDelivery snapshot is the generation the
 * server handed that attempt; an incoming error matches only when machine,
 * launch and session all agree. An old generation's error must NOT cancel a
 * newer attempt (the newer delivery keeps its own tracker and budget).
 */
export function terminalErrorMatchesTrackedGeneration(
  tracked: { machineId: string; mentionDelivery?: DeliveryGeneration | undefined },
  incoming: DeliveryGeneration,
): boolean {
  if (!tracked.mentionDelivery) {
    // Untracked delivery: machine identity is the only generation signal.
    return tracked.machineId === incoming.machineId;
  }
  return tracked.mentionDelivery.machineId === incoming.machineId
    && tracked.mentionDelivery.launchId === incoming.launchId
    && tracked.mentionDelivery.sessionId === incoming.sessionId;
}

/**
 * Identity of the sender cannot be confirmed (agent row lacks launch/session
 * or the message fails validation): stop re-sending the CURRENT attempt —
 * the storm has no payload — but keep the durable occurrence recoverable:
 * no terminal mark, so machine-ready recovery can still deliver the unread
 * message once the agent is back.
 */
export function unconfirmableIdentityVerdict(): {
  stopCurrentAttempt: true;
  keepRecoverable: true;
} {
  return { stopCurrentAttempt: true, keepRecoverable: true };
}
