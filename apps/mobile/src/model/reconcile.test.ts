import assert from "node:assert/strict";
import test from "node:test";
import { hasSeqGap, reconcileIncoming } from "./reconcile.ts";
import type { RaftMessage } from "./messages.ts";

const base = (patch: Partial<RaftMessage>): RaftMessage => ({
  id: "m1",
  channelId: "c1",
  content: "hi",
  ...patch,
});

test("hasSeqGap is true only when a newer seq skips ahead of the local max", () => {
  assert.equal(hasSeqGap(0, 4), false);
  assert.equal(hasSeqGap(10, 11), false);
  assert.equal(hasSeqGap(10, 12), true);
});

test("reconcileIncoming replaces the optimistic row with the same randomId", () => {
  const optimistic = base({ id: "optimistic-abc", randomId: "abc", content: "hi", seq: undefined });
  const persisted = base({ id: "server-1", randomId: "abc", content: "hi", seq: 8 });
  const merged = reconcileIncoming([optimistic], persisted);
  assert.deepEqual(merged.map((message) => message.id), ["server-1"]);
});
