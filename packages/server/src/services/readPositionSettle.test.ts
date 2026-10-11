import assert from "node:assert/strict";
import { test } from "vitest";
import {
  pendingDeferredReadAdvanceCount,
  scheduleDeferredReadAdvance,
  settledReadThroughSeq,
  setReadPositionSettleMsForTests,
  type DeferredReadAdvance,
} from "./readPositionSettle.js";

/** The pure half of the upstream 1.21.2 readPositionSettle port. */

test("settledReadThroughSeq stops at the first row that is too new, in seq order", () => {
  const old = new Date(0);
  const fresh = new Date(10_000);
  assert.equal(settledReadThroughSeq([{ seq: 3, createdAt: old }, { seq: 1, createdAt: old }, { seq: 2, createdAt: old }], 5_000), 3);
  assert.equal(settledReadThroughSeq([{ seq: 1, createdAt: old }, { seq: 2, createdAt: fresh }, { seq: 3, createdAt: old }], 5_000), 1);
  assert.equal(settledReadThroughSeq([{ seq: 1, createdAt: fresh }], 5_000), null);
  assert.equal(settledReadThroughSeq([], 5_000), null);
});

function deferredFixture(overrides: Partial<DeferredReadAdvance> = {}): {
  input: DeferredReadAdvance;
  advancedTo: number[];
  outcomes: string[];
} {
  const advancedTo: number[] = [];
  const outcomes: string[] = [];
  const input: DeferredReadAdvance = {
    agentId: "agent-1",
    channelId: "channel-1",
    fromSeq: 10,
    returnedSeqs: [11, 12, 13],
    listSeqs: async () => [],
    advance: async (seq) => { advancedTo.push(seq); },
    record: (outcome) => { outcomes.push(outcome); },
    ...overrides,
  };
  return { input, advancedTo, outcomes };
}

test("deferred check advances to the max returned seq when no late seq appeared", async () => {
  const restore = setReadPositionSettleMsForTests(1);
  try {
    const { input, advancedTo, outcomes } = deferredFixture({
      listSeqs: async () => [11, 12, 13],
    });
    scheduleDeferredReadAdvance(input);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(advancedTo, [13]);
    assert.deepEqual(outcomes, ["advanced"]);
  } finally {
    restore();
  }
});

test("deferred check stops before a late-committed seq the read never returned", async () => {
  const restore = setReadPositionSettleMsForTests(1);
  try {
    const { input, advancedTo, outcomes } = deferredFixture({
      // seq 12 committed late, after the read returned 11 and 13.
      listSeqs: async () => [11, 12, 13],
      returnedSeqs: [11, 13],
    });
    scheduleDeferredReadAdvance(input);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(advancedTo, [11], "must stop before the gap, not skip it");
    assert.deepEqual(outcomes, ["gap_found"]);
  } finally {
    restore();
  }
});

test("a newer read cancels the older pending check", async () => {
  const restore = setReadPositionSettleMsForTests(1_000);
  try {
    const first = deferredFixture();
    scheduleDeferredReadAdvance(first.input);
    assert.equal(pendingDeferredReadAdvanceCount(), 1);
    const second = deferredFixture({ channelId: "channel-2" });
    scheduleDeferredReadAdvance(second.input);
    // Same (agent, channel) key: the second fixture used another channel, so
    // both are pending; cancel via a same-key replacement instead.
    const replacement = deferredFixture();
    scheduleDeferredReadAdvance(replacement.input);
    assert.equal(pendingDeferredReadAdvanceCount(), 2);
    assert.deepEqual(first.outcomes, ["skipped_newer_read"], "the replaced check records its cancellation");
  } finally {
    restore();
    // Drain the two still-pending timers so they outlive neither the test
    // process nor each other deterministically.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
});
