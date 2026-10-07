import assert from "node:assert/strict";
import test from "node:test";
import { catchUpPlan, releaseFocus, shouldApplyServerResponse, shouldCommitTokens, shouldMarkVisibleRead } from "./sessionPolicy.ts";

test("shouldCommitTokens drops a refresh that outlives logout", () => {
  assert.equal(shouldCommitTokens(1, 1), true);
  assert.equal(shouldCommitTokens(1, 2), false);
});

test("shouldApplyServerResponse ignores a server switch without touching auth", () => {
  assert.equal(shouldApplyServerResponse(1, 1), true);
  assert.equal(shouldApplyServerResponse(1, 2), false);
});

test("releaseFocus keeps a newer screen's channel", () => {
  assert.equal(releaseFocus("channel-1", "channel-1"), null);
  assert.equal(releaseFocus("thread-1", "channel-1"), "thread-1");
});

test("shouldMarkVisibleRead only for the channel on screen", () => {
  assert.equal(shouldMarkVisibleRead("channel-1", "channel-1"), true);
  assert.equal(shouldMarkVisibleRead("thread-1", "channel-1"), false);
  assert.equal(shouldMarkVisibleRead(null, "channel-1"), false);
});

test("catchUpPlan refreshes the directory only when resume has more", () => {
  assert.deepEqual(catchUpPlan(true), { refreshDirectory: true, refreshUnread: true });
  assert.deepEqual(catchUpPlan(false), { refreshDirectory: false, refreshUnread: false });
});
