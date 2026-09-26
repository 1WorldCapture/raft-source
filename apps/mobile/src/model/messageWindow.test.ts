import assert from "node:assert/strict";
import test from "node:test";
import { advanceContextWindow, applyContextWindow, appendNewerPage, forgetContextWindow, parseMessageContext, recallContextWindow, rememberContextWindow, shouldRequestContext, visibleInWindow } from "./messageWindow.ts";
import type { RaftMessage } from "./messages.ts";

function message(id: string, seq: number): RaftMessage {
  return { id, seq, channelId: "c1", content: id };
}

test("parseMessageContext reads the window flags and drops a non-record", () => {
  const page = parseMessageContext({
    targetMessageId: "m2",
    hasOlder: true,
    hasNewer: false,
    messages: [message("m2", 2)],
  });
  assert.equal(page?.targetMessageId, "m2");
  assert.equal(page?.hasOlder, true);
  assert.equal(page?.hasNewer, false);
  assert.deepEqual(page?.messages.map((item) => item.id), ["m2"]);
  assert.equal(parseMessageContext(null), null);
  assert.equal(parseMessageContext({ messages: [] })?.hasOlder, false);
});

test("shouldRequestContext skips a target that is already loaded", () => {
  assert.equal(shouldRequestContext([message("m1", 1)], "m1"), false);
  assert.equal(shouldRequestContext([message("m1", 1)], "m9"), true);
  assert.equal(shouldRequestContext([message("m1", 1)], null), false);
});

test("applyContextWindow keeps the slice and drops messages outside it", () => {
  const window = applyContextWindow(
    [message("old", 1), message("tail", 500), message("m2", 20)],
    {
      targetMessageId: "m2",
      hasOlder: true,
      hasNewer: true,
      messages: [message("m2", 20), message("m3", 21)],
    },
  );
  assert.deepEqual(window.messages.map((item) => item.id), ["m2", "m3"]);
  assert.equal(window.hasOlder, true);
  assert.equal(window.hasNewer, true);
  assert.equal(window.ceilingSeq, 21);
});

test("appendNewerPage stays open until a short page reaches the tail", () => {
  const full = appendNewerPage([message("m1", 1)], [message("m2", 2), message("m3", 3)], 2);
  assert.equal(full.hasNewer, true);
  assert.equal(full.ceilingSeq, 3);
  const done = appendNewerPage(full.messages, [message("m4", 4)], 2);
  assert.equal(done.hasNewer, false);
  assert.deepEqual(done.messages.map((item) => item.id), ["m1", "m2", "m3", "m4"]);
});

test("a remembered window survives until the ceiling row is gone or the channel is cleared", () => {
  rememberContextWindow("c1", "m1", { ceilingSeq: 10, hasOlder: false });
  assert.deepEqual(recallContextWindow("c1", "m1", [message("m1", 10)]), { ceilingSeq: 10, hasOlder: false });
  advanceContextWindow("c1", "m1", 20);
  assert.equal(recallContextWindow("c1", "m1", [message("m1", 10)])?.ceilingSeq, undefined);
  assert.equal(recallContextWindow("c1", "m1", [message("m2", 20)])?.ceilingSeq, 20);
  forgetContextWindow("c1");
  assert.equal(recallContextWindow("c1", "m1", [message("m2", 20)]), null);
});

test("visibleInWindow hides live messages past the ceiling while newer history remains", () => {
  const messages = [message("m1", 10), message("live", 400)];
  assert.deepEqual(visibleInWindow(messages, true, 10).map((item) => item.id), ["m1"]);
  assert.equal(visibleInWindow(messages, false, 10), messages);
});
