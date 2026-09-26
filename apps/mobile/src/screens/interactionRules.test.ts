import assert from "node:assert/strict";
import test from "node:test";
import { claimReaction, releaseReaction, threadMenuActions } from "./interactionRules";

test("a second reaction tap does not start another request for the same emoji", () => {
  const inFlight = new Set<string>();
  assert.equal(claimReaction(inFlight, "message-1", "👍"), true);
  assert.equal(claimReaction(inFlight, "message-1", "👍"), false);
  assert.equal(claimReaction(inFlight, "message-1", "❤️"), true);
  releaseReaction(inFlight, "message-1", "👍");
  assert.equal(claimReaction(inFlight, "message-1", "👍"), true);
});

test("a thread page hides open-thread, follow, and convert-to-task", () => {
  assert.deepEqual(threadMenuActions({ inThread: true, threadChannelId: "thread-1" }), {
    openThread: false,
    follow: false,
    task: false,
  });
  assert.deepEqual(threadMenuActions({ inThread: false, threadChannelId: "thread-1" }), {
    openThread: true,
    follow: true,
    task: true,
  });
  assert.deepEqual(threadMenuActions({ inThread: false }), {
    openThread: true,
    follow: false,
    task: true,
  });
});
