import assert from "node:assert/strict";
import test from "node:test";
import { catchUpPlan, releaseFocus, shouldCommitSession, shouldMarkVisibleRead } from "./sessionPolicy.ts";

test("shouldCommitSession rejects a refresh that outlives logout", () => {
  assert.equal(shouldCommitSession(1, 1), true);
  assert.equal(shouldCommitSession(1, 2), false);
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
