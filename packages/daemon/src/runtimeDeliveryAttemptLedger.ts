import {
  inboxNoticeMessageIdentity,
  type InboxNoticeIdentityMessage,
} from "./runtimeNotificationState.js";

/**
 * Delivery-outcome attempt ledger (cursor-sdk APM integration).
 *
 * The APM owns attempt watermarks for runtimes that participate in the
 * delivery-outcome acknowledgment protocol (`driver.deliveryOutcomeAttempts`):
 * every follow-up stdin send may carry an APM-allocated `attemptId`, and the
 * runtime answers later with exactly one `delivery_outcome` ParsedEvent per
 * attempt (`delivered` | `deferred_to_idle` | `unknown`).
 *
 * The ledger is deliberately a pure per-process state machine:
 * - no timers, no IO, no tracing — the APM composition root drives effects;
 * - attempt ids are monotonically increasing integers per process instance, so
 *   an outcome can be classified as applied / duplicate / stale / unallocated
 *   without trusting the runtime to echo ids correctly;
 * - attempt records snapshot the EXACT contribution identities of the send, so
 *   a later `deferred_to_idle` restores debt only for messages that are still
 *   unread — never a wholesale contribution-memo wipe that would re-notify
 *   previously delivered messages (the retired #5911 retry-storm class);
 * - `unknown` outcomes are retained (contribution kept, debt NOT restored)
 *   until a terminal boundary — the APM, as sole follow-up owner, resolves
 *   them there instead of the runtime auto-following-up.
 */
export type RuntimeDeliveryAttemptOutcome = "delivered" | "deferred_to_idle" | "unknown";

export interface RuntimeDeliveryAttemptContribution {
  readonly attemptId: string;
  readonly sessionId: string | null;
  /** Contribution identities snapshot at send time (never contains ""). */
  readonly identities: ReadonlySet<string>;
}

export type RuntimeDeliveryAttemptSettleDisposition =
  | {
      status: "applied";
      attempt: RuntimeDeliveryAttemptContribution;
      outcome: RuntimeDeliveryAttemptOutcome;
    }
  | {
      status: "duplicate";
      attemptId: string;
      previousOutcome: RuntimeDeliveryAttemptOutcome;
    }
  | { status: "stale"; attemptId: string }
  | { status: "unallocated"; attemptId: string };

export function runtimeDeliveryAttemptMessageIdentities(
  messages: readonly InboxNoticeIdentityMessage[],
): Set<string> {
  const identities = new Set<string>();
  for (const message of messages) {
    const identity = inboxNoticeMessageIdentity(message);
    if (identity.length > 0) identities.add(identity);
  }
  return identities;
}

/** Bounded so a chatty runtime cannot grow settle history without limit. */
const SETTLE_HISTORY_LIMIT = 32;
/** Retained-unknown attempts are rarer (ACK timeouts); keep a smaller bound. */
const RETAINED_UNKNOWN_LIMIT = 16;

export class RuntimeDeliveryAttemptLedger {
  private nextAttemptSeq = 0;
  private highestAllocatedSeq = 0;
  private readonly pendingById = new Map<string, { seq: number; sessionId: string | null; identities: Set<string> }>();
  private readonly settleHistory = new Map<string, RuntimeDeliveryAttemptOutcome>();
  private retainedUnknown: RuntimeDeliveryAttemptContribution[] = [];
  private suppressBusyDeliveryUntilIdle = false;

  /** Allocate the next monotonic attempt id (APM-owned watermark). */
  allocateAttemptId(): string {
    this.nextAttemptSeq += 1;
    this.highestAllocatedSeq = this.nextAttemptSeq;
    return String(this.nextAttemptSeq);
  }

  get pendingCount(): number {
    return this.pendingById.size;
  }

  get retainedUnknownCount(): number {
    return this.retainedUnknown.length;
  }

  /**
   * Snapshot the contribution identities of a successfully accepted send.
   * Recording never replaces: multiple attempts may await outcomes
   * concurrently (e.g. an idle delivery followed by a busy notice).
   */
  recordPendingAttempt(
    attemptId: string,
    sessionId: string | null,
    messages: readonly InboxNoticeIdentityMessage[],
  ): RuntimeDeliveryAttemptContribution {
    const existing = this.pendingById.get(attemptId);
    if (existing) {
      return { attemptId, sessionId: existing.sessionId, identities: existing.identities };
    }
    const identities = runtimeDeliveryAttemptMessageIdentities(messages);
    this.pendingById.set(attemptId, { seq: this.attemptSeq(attemptId) ?? 0, sessionId, identities });
    return { attemptId, sessionId, identities };
  }

  /**
   * Classify an incoming delivery_outcome. `currentSessionId` scopes attempts:
   * a pending attempt recorded under another session is retired by the
   * rollover (its contribution memo is session-scoped anyway, so nothing can
   * be restored for it) and reported as stale instead of applied.
   */
  settle(
    attemptId: string,
    outcome: RuntimeDeliveryAttemptOutcome,
    currentSessionId: string | null,
  ): RuntimeDeliveryAttemptSettleDisposition {
    const pending = this.pendingById.get(attemptId);
    if (pending) {
      this.pendingById.delete(attemptId);
      this.recordSettled(attemptId, outcome);
      if (pending.sessionId !== currentSessionId) {
        return { status: "stale", attemptId };
      }
      if (outcome === "unknown") {
        this.pushRetainedUnknown({ attemptId, sessionId: pending.sessionId, identities: pending.identities });
      } else if (outcome === "deferred_to_idle") {
        // The runtime reverted the submission; the current run keeps going and
        // further busy steering must wait for true idle (held by both the APM
        // here and by the runtime host itself).
        this.suppressBusyDeliveryUntilIdle = true;
      }
      return {
        status: "applied",
        attempt: { attemptId, sessionId: pending.sessionId, identities: pending.identities },
        outcome,
      };
    }

    const previousOutcome = this.settleHistory.get(attemptId);
    if (previousOutcome !== undefined) {
      return { status: "duplicate", attemptId, previousOutcome };
    }
    const seq = this.attemptSeq(attemptId);
    if (seq !== null && seq <= this.highestAllocatedSeq) {
      return { status: "stale", attemptId };
    }
    return { status: "unallocated", attemptId };
  }

  /**
   * True while busy-path steering must be held after a revert, until a turn
   * boundary proves true idle. Never gates idle-mode delivery.
   */
  shouldSuppressBusyDelivery(): boolean {
    return this.suppressBusyDeliveryUntilIdle;
  }

  /** Clears the post-revert busy hold; returns true when it actually cleared. */
  clearBusySuppression(): boolean {
    if (!this.suppressBusyDeliveryUntilIdle) return false;
    this.suppressBusyDeliveryUntilIdle = false;
    return true;
  }

  /**
   * Take the retained-unknown attempts that still belong to the current
   * session. All retained entries are consumed; entries retired by a session
   * rollover are dropped (their contribution memo cannot suppress the new
   * session's deliveries, so no debt restore is needed for them).
   */
  takeRetainedUnknown(currentSessionId: string | null): RuntimeDeliveryAttemptContribution[] {
    if (this.retainedUnknown.length === 0) return [];
    const matching = this.retainedUnknown.filter((attempt) => attempt.sessionId === currentSessionId);
    this.retainedUnknown = [];
    return matching;
  }

  private pushRetainedUnknown(attempt: RuntimeDeliveryAttemptContribution): void {
    this.retainedUnknown.push(attempt);
    if (this.retainedUnknown.length > RETAINED_UNKNOWN_LIMIT) {
      this.retainedUnknown.splice(0, this.retainedUnknown.length - RETAINED_UNKNOWN_LIMIT);
    }
  }

  private recordSettled(attemptId: string, outcome: RuntimeDeliveryAttemptOutcome): void {
    this.settleHistory.set(attemptId, outcome);
    if (this.settleHistory.size > SETTLE_HISTORY_LIMIT) {
      const oldest = this.settleHistory.keys().next();
      if (!oldest.done) this.settleHistory.delete(oldest.value);
    }
  }

  private attemptSeq(attemptId: string): number | null {
    if (!/^\d+$/.test(attemptId)) return null;
    const seq = Number(attemptId);
    return Number.isSafeInteger(seq) ? seq : null;
  }
}

export function createRuntimeDeliveryAttemptLedger(): RuntimeDeliveryAttemptLedger {
  return new RuntimeDeliveryAttemptLedger();
}
