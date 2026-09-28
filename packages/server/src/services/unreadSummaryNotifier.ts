import { AsyncLocalStorage } from "node:async_hooks";
import { UNREAD_SUMMARY_CHANGED_EVENT, type UnreadSummaryChangedPayload } from "@botiverse/raft-shared";
import { isReceiverStatePushEnabled } from "./receiverStatePushService.js";

/**
 * Tells a user's clients that a server's unread summary may have changed
 * (`unread_summary:changed { serverId }` to `user:<userId>`), so badges that
 * cache `/servers/unread-summary` re-fetch instead of going stale.
 *
 * Two cadences per (user, server):
 * - "user_action" (reads, Done, mute, membership): trailing debounce of
 *   USER_ACTION_DEBOUNCE_MS — fast, and bursts collapse to one event.
 * - "activity" (new inbox rows from other people's messages): first event
 *   after ACTIVITY_LEADING_DELAY_MS, then at most one per
 *   ACTIVITY_MIN_INTERVAL_MS while messages keep arriving, so a busy channel
 *   cannot make every client re-fetch continuously.
 *
 * Emission always happens on a timer, never synchronously, so callers inside
 * a database transaction notify after their commit. Each replica keeps its own
 * timers; a duplicate event across replicas only causes an idempotent re-fetch.
 */

export const USER_ACTION_DEBOUNCE_MS = 500;
export const ACTIVITY_LEADING_DELAY_MS = 250;
export const ACTIVITY_MIN_INTERVAL_MS = 3_000;

export type UnreadSummaryChangeReason = "user_action" | "activity";

type Emitter = { to(room: string): { emit(event: string, payload: unknown): unknown } };
type TimerHandle = ReturnType<typeof setTimeout>;

interface KeyState {
  timer: TimerHandle | null;
  dueAt: number;
  lastEmitAt: number;
}

let io: Emitter | null = null;
const cadenceScope = new AsyncLocalStorage<UnreadSummaryChangeReason>();

/**
 * Run `fn` with every notification inside it using `reason`'s cadence. The
 * send path wraps the sender's own read-cursor advance in "activity" so a
 * user sending messages quickly is rate-limited like any message stream,
 * while reads the user actually performs keep the fast debounce.
 */
export function withUnreadSummaryCadence<T>(reason: UnreadSummaryChangeReason, fn: () => T): T {
  return cadenceScope.run(reason, fn);
}
let now: () => number = () => Date.now();
const states = new Map<string, KeyState>();

export function setUnreadSummaryIO(next: Emitter | null): void {
  io = next;
}

function keyOf(userId: string, serverId: string): string {
  return `${userId}\u0000${serverId}`;
}

function emit(userId: string, serverId: string, state: KeyState): void {
  state.timer = null;
  state.lastEmitAt = now();
  if (!io || !isReceiverStatePushEnabled()) return;
  const payload: UnreadSummaryChangedPayload = { serverId };
  io.to(`user:${userId}`).emit(UNREAD_SUMMARY_CHANGED_EVENT, payload);
}

function schedule(userId: string, serverId: string, state: KeyState, dueAt: number): void {
  if (state.timer) clearTimeout(state.timer);
  state.dueAt = dueAt;
  const timer = setTimeout(() => {
    emit(userId, serverId, state);
    // Forget idle keys once the rate-limit window has passed.
    const cleanup = setTimeout(() => {
      const current = states.get(keyOf(userId, serverId));
      if (current === state && !state.timer && now() - state.lastEmitAt >= ACTIVITY_MIN_INTERVAL_MS) {
        states.delete(keyOf(userId, serverId));
      }
    }, ACTIVITY_MIN_INTERVAL_MS);
    cleanup.unref?.();
  }, Math.max(0, dueAt - now()));
  timer.unref?.();
  state.timer = timer;
}

export function notifyUnreadSummaryChanged(input: {
  userIds: Iterable<string>;
  serverId: string | null | undefined;
  reason: UnreadSummaryChangeReason;
}): void {
  const serverId = input.serverId;
  if (!serverId) return;
  const reason = cadenceScope.getStore() ?? input.reason;
  for (const userId of new Set(input.userIds)) {
    if (!userId) continue;
    const key = keyOf(userId, serverId);
    let state = states.get(key);
    if (!state) {
      state = { timer: null, dueAt: 0, lastEmitAt: Number.NEGATIVE_INFINITY };
      states.set(key, state);
    }
    const at = now();
    if (reason === "user_action") {
      // Trailing debounce: each action pushes the single pending emit out.
      schedule(userId, serverId, state, at + USER_ACTION_DEBOUNCE_MS);
      continue;
    }
    // activity: coalesce into any pending emit; otherwise respect the
    // minimum interval since the last emit.
    if (state.timer) continue;
    schedule(userId, serverId, state, Math.max(at + ACTIVITY_LEADING_DELAY_MS, state.lastEmitAt + ACTIVITY_MIN_INTERVAL_MS));
  }
}

/** Test hooks: deterministic clock and state reset. */
export const __testUnreadSummaryNotifier = {
  setClock(clock: (() => number) | null) {
    now = clock ?? (() => Date.now());
  },
  reset() {
    for (const state of states.values()) if (state.timer) clearTimeout(state.timer);
    states.clear();
  },
  pendingCount() {
    return [...states.values()].filter((state) => state.timer).length;
  },
};
