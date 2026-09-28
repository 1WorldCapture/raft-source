import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { UNREAD_SUMMARY_CHANGED_EVENT } from "@botiverse/raft-shared";
import {
  __testUnreadSummaryNotifier,
  ACTIVITY_LEADING_DELAY_MS,
  ACTIVITY_MIN_INTERVAL_MS,
  notifyUnreadSummaryChanged,
  setUnreadSummaryIO,
  USER_ACTION_DEBOUNCE_MS,
} from "./unreadSummaryNotifier.js";

type Emitted = { room: string; event: string; payload: unknown; at: number };
let emitted: Emitted[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  __testUnreadSummaryNotifier.setClock(() => Date.now());
  emitted = [];
  setUnreadSummaryIO({
    to(room: string) {
      return { emit(event: string, payload: unknown) { emitted.push({ room, event, payload, at: Date.now() }); } };
    },
  });
});

afterEach(() => {
  __testUnreadSummaryNotifier.reset();
  setUnreadSummaryIO(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("user actions debounce into one event to the user's room after the last action", () => {
  const start = Date.now();
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "user_action" });
  vi.advanceTimersByTime(300);
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "user_action" });
  vi.advanceTimersByTime(USER_ACTION_DEBOUNCE_MS - 1);
  assert.equal(emitted.length, 0, "still inside the debounce window");
  vi.advanceTimersByTime(1);
  assert.deepEqual(emitted.map(({ room, event, payload }) => ({ room, event, payload })), [
    { room: "user:u1", event: UNREAD_SUMMARY_CHANGED_EVENT, payload: { serverId: "s1" } },
  ]);
  assert.equal(emitted[0]!.at - start, 300 + USER_ACTION_DEBOUNCE_MS);
});

test("keys are per user and per server", () => {
  notifyUnreadSummaryChanged({ userIds: ["u1", "u2", "u1"], serverId: "s1", reason: "user_action" });
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s2", reason: "user_action" });
  vi.advanceTimersByTime(USER_ACTION_DEBOUNCE_MS);
  assert.deepEqual(
    emitted.map(({ room, payload }) => `${room}|${(payload as { serverId: string }).serverId}`).sort(),
    ["user:u1|s1", "user:u1|s2", "user:u2|s1"],
  );
});

test("activity: first event after the leading delay, then at most one per minimum interval under a steady stream", () => {
  const start = Date.now();
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "activity" });
  vi.advanceTimersByTime(ACTIVITY_LEADING_DELAY_MS);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.at - start, ACTIVITY_LEADING_DELAY_MS);

  // A message every 100 ms for 12 s.
  for (let elapsed = 0; elapsed < 12_000; elapsed += 100) {
    notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "activity" });
    vi.advanceTimersByTime(100);
  }
  vi.advanceTimersByTime(ACTIVITY_MIN_INTERVAL_MS);
  const gaps = emitted.slice(1).map((event, index) => event.at - emitted[index]!.at);
  assert.ok(gaps.every((gap) => gap >= ACTIVITY_MIN_INTERVAL_MS), `gaps ${gaps.join(",")}`);
  assert.ok(emitted.length <= 1 + Math.ceil(12_250 / ACTIVITY_MIN_INTERVAL_MS) + 1, `emitted ${emitted.length}`);
  assert.ok(emitted.length >= 4, "the stream still produces periodic refreshes");
});

test("a user action is not held back by the activity rate limit", () => {
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "activity" });
  vi.advanceTimersByTime(ACTIVITY_LEADING_DELAY_MS);
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "activity" });
  // The activity emit is now scheduled ~3 s out; the user reads.
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "user_action" });
  vi.advanceTimersByTime(USER_ACTION_DEBOUNCE_MS);
  assert.equal(emitted.length, 2, "the read is reflected within the debounce window");
});

test("nothing is emitted when receiver-state push is disabled or no server id is known", () => {
  vi.stubEnv("SLOCK_RECEIVER_STATE_PUSH_ENABLED", "0");
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: "s1", reason: "user_action" });
  vi.advanceTimersByTime(USER_ACTION_DEBOUNCE_MS);
  assert.equal(emitted.length, 0);
  vi.unstubAllEnvs();
  notifyUnreadSummaryChanged({ userIds: ["u1"], serverId: null, reason: "user_action" });
  vi.advanceTimersByTime(USER_ACTION_DEBOUNCE_MS);
  assert.equal(emitted.length, 0);
});
