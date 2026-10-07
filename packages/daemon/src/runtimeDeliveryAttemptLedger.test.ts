import assert from "node:assert/strict";
import { test } from "vitest";
import {
  RuntimeDeliveryAttemptLedger,
  runtimeDeliveryAttemptMessageIdentities,
} from "./runtimeDeliveryAttemptLedger.js";
import { RuntimeNotificationState } from "./runtimeNotificationState.js";
import type { AgentMessage } from "@botiverse/raft-shared";

function message(id: string, seq: number): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "richard",
    sender_type: "human",
    content: `message ${id}`,
    timestamp: "2026-10-05T10:00:00.000Z",
    message_id: id,
    seq,
  };
}

test("attempt ids are monotonic watermarks owned by the ledger", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  assert.equal(ledger.allocateAttemptId(), "1");
  assert.equal(ledger.allocateAttemptId(), "2");
  assert.equal(ledger.allocateAttemptId(), "3");
});

test("identity snapshot skips messages without a usable identity", () => {
  const identities = runtimeDeliveryAttemptMessageIdentities([
    message("m-1", 1),
    { content: "no identity" } as AgentMessage,
  ]);
  assert.deepEqual([...identities], ["s:1"]);
});

test("delivered settles and a duplicate outcome for the same attempt is discarded", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  const attemptId = ledger.allocateAttemptId();
  const messages = [message("m-1", 1), message("m-2", 2)];
  ledger.recordPendingAttempt(attemptId, "session-1", messages);

  const first = ledger.settle(attemptId, "delivered", "session-1");
  assert.equal(first.status, "applied");
  assert.equal(first.status === "applied" && first.outcome, "delivered");
  assert.equal(first.status === "applied" && first.attempt.identities.size, 2);

  const duplicate = ledger.settle(attemptId, "deferred_to_idle", "session-1");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.status === "duplicate" && duplicate.previousOutcome, "delivered");
  assert.equal(ledger.shouldSuppressBusyDelivery(), false, "duplicate must not arm the busy hold");
  assert.equal(ledger.retainedUnknownCount, 0, "duplicate must not retain an unknown");
});

test("deferred_to_idle arms the busy hold until cleared at a terminal boundary", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  const attemptId = ledger.allocateAttemptId();
  ledger.recordPendingAttempt(attemptId, "session-1", [message("m-1", 1)]);

  const outcome = ledger.settle(attemptId, "deferred_to_idle", "session-1");
  assert.equal(outcome.status, "applied");
  assert.equal(ledger.shouldSuppressBusyDelivery(), true);
  assert.equal(ledger.clearBusySuppression(), true);
  assert.equal(ledger.shouldSuppressBusyDelivery(), false);
  assert.equal(ledger.clearBusySuppression(), false, "second clear is a no-op");
});

test("unknown outcomes are retained per session and consumed exactly once", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  const attemptOne = ledger.allocateAttemptId();
  ledger.recordPendingAttempt(attemptOne, "session-1", [message("m-1", 1)]);
  const attemptTwo = ledger.allocateAttemptId();
  ledger.recordPendingAttempt(attemptTwo, "session-2", [message("m-2", 2)]);

  assert.equal(ledger.settle(attemptOne, "unknown", "session-1").status, "applied");
  assert.equal(ledger.settle(attemptTwo, "unknown", "session-2").status, "applied");
  assert.equal(ledger.retainedUnknownCount, 2);

  // Session rollover retires the other session's retained attempt.
  const taken = ledger.takeRetainedUnknown("session-1");
  assert.equal(taken.length, 1);
  assert.equal(taken[0]!.attemptId, attemptOne);
  assert.equal(taken[0]!.identities.has("s:1"), true);
  assert.equal(ledger.retainedUnknownCount, 0, "take consumes every retained entry");
  assert.deepEqual(ledger.takeRetainedUnknown("session-1"), [], "second take is empty");
});

test("allocated-but-unrecorded attempts classify as stale; bogus ids as unallocated", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  // Id allocated, but the send failed so no pending record was made.
  const allocatedNeverRecorded = ledger.allocateAttemptId();
  assert.equal(ledger.settle(allocatedNeverRecorded, "delivered", "session-1").status, "stale");

  // Far-future id never allocated.
  assert.equal(ledger.settle("999", "unknown", "session-1").status, "unallocated");
  // Non-numeric garbage must not be treated as a numeric watermark.
  assert.equal(ledger.settle("drop table", "unknown", "session-1").status, "unallocated");
});

test("a pending attempt recorded under another session settles as stale on rollover", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  const attemptId = ledger.allocateAttemptId();
  ledger.recordPendingAttempt(attemptId, "session-1", [message("m-1", 1)]);

  const outcome = ledger.settle(attemptId, "deferred_to_idle", "session-2");
  assert.equal(outcome.status, "stale");
  assert.equal(ledger.shouldSuppressBusyDelivery(), false, "rolled-over revert must not hold busy delivery");
  assert.equal(ledger.pendingCount, 0);
});

test("recordPendingAttempt is idempotent per attempt id", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  const attemptId = ledger.allocateAttemptId();
  const first = ledger.recordPendingAttempt(attemptId, "session-1", [message("m-1", 1)]);
  const second = ledger.recordPendingAttempt(attemptId, "session-1", [message("m-2", 2)]);
  assert.equal(second.attemptId, first.attemptId);
  assert.equal(second.identities.size, first.identities.size, "the first snapshot wins");
  assert.equal(ledger.pendingCount, 1);
});

test("settle history stays bounded under a chatty runtime", () => {
  const ledger = new RuntimeDeliveryAttemptLedger();
  for (let index = 0; index < 40; index += 1) {
    const attemptId = ledger.allocateAttemptId();
    ledger.recordPendingAttempt(attemptId, "session-1", [message(`m-${index}`, index + 1)]);
    ledger.settle(attemptId, "delivered", "session-1");
  }
  const oldest = ledger.settle("1", "delivered", "session-1");
  assert.equal(oldest.status, "stale", "evicted history degrades to stale (watermark-guarded), never to applied");
  const recent = ledger.settle("40", "delivered", "session-1");
  assert.equal(recent.status, "duplicate");
});

test("uncontributeMessages removes exactly the given rows and only clears a matching written fingerprint", () => {
  const notifications = new RuntimeNotificationState();
  const contributedA = message("m-a", 1);
  const contributedB = message("m-b", 2);
  const outsider = message("m-c", 3);

  // One written notice contributed A and B; a later notice contributed C.
  notifications.recordNoticeWritten("s:1", "session-1", [contributedA]);
  notifications.recordNoticeWritten("s:2,s:3", "session-1", [contributedB, outsider]);

  // Reverting the A+B attempt: only A is still unread (B was consumed), so the
  // caller passes [A]; the partial removed set does not match the last written
  // notice (s:2,s:3), so that memo must survive to keep suppressing its own
  // exact re-send.
  assert.equal(notifications.uncontributeMessages([contributedA], "session-1"), 1);
  assert.equal(notifications.hasContributedMessage(contributedA, "session-1"), false);
  assert.equal(notifications.hasContributedMessage(contributedB, "session-1"), true);
  assert.equal(notifications.hasContributedMessage(outsider, "session-1"), true);
  assert.equal(notifications.isDuplicateNotice("s:2,s:3", "session-1"), true);

  // Reverting an attempt whose removed set IS the last written notice clears
  // that memo: the reverted write must not suppress re-sending itself.
  assert.equal(notifications.uncontributeMessages([contributedB, outsider], "session-1"), 2);
  assert.equal(notifications.hasContributedMessage(contributedB, "session-1"), false);
  assert.equal(notifications.hasContributedMessage(outsider, "session-1"), false);
  assert.equal(notifications.isDuplicateNotice("s:2,s:3", "session-1"), false);

  // Cross-session uncontribute is a no-op.
  assert.equal(notifications.uncontributeMessages([contributedA], "session-2"), 0);
});
