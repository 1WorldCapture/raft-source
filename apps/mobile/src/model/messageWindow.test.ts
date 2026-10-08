import assert from "node:assert/strict";
import test from "node:test";
import { advanceContextWindow, applyContextWindow, appendNewerPage, applyMemoryCap, forgetContextWindow, HISTORY_LIMIT, parseMessageContext, recallContextWindow, rememberContextWindow, retainNewest, retainOldest, shouldFollowTail, shouldRequestContext, TAIL_LIMIT, visibleInWindow } from "./messageWindow.ts";
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

function range(from: number, through: number): RaftMessage[] {
  const messages: RaftMessage[] = [];
  for (let seq = from; seq <= through; seq += 1) messages.push(message(`m${seq}`, seq));
  return messages;
}

test("the open window keeps one page at the tail and four pages while reading history", () => {
  const loaded = range(1, 80);
  const tail = applyMemoryCap(loaded, true);
  assert.equal(tail.droppedOlder, true);
  assert.equal(tail.droppedTail, false);
  assert.equal(tail.messages.length, TAIL_LIMIT);
  assert.equal(tail.messages[0]?.seq, 31);
  assert.equal(tail.messages.at(-1)?.seq, 80);

  const older = range(1, TAIL_LIMIT);
  const grown = applyMemoryCap([...older, ...range(TAIL_LIMIT + 1, 90)], false);
  assert.equal(grown.droppedTail, false);
  assert.equal(grown.messages.length, 90);

  const overflow = applyMemoryCap(range(1, HISTORY_LIMIT + 20), false);
  assert.equal(overflow.droppedTail, true);
  assert.equal(overflow.messages.length, HISTORY_LIMIT);
  assert.equal(overflow.messages[0]?.seq, 1);
  assert.equal(overflow.messages.at(-1)?.seq, HISTORY_LIMIT);
  assert.equal(overflow.messages.some((item) => item.seq === HISTORY_LIMIT + 20), false);
});

test("an optimistic send stays in the tail window", () => {
  const messages = [...range(1, 60), { id: "optimistic-1", channelId: "c1", content: "hi" }];
  const kept = retainNewest(messages, TAIL_LIMIT);
  assert.equal(kept.length, TAIL_LIMIT + 1);
  assert.equal(kept.at(-1)?.id, "optimistic-1");
  assert.equal(kept[0]?.seq, 11);
  assert.equal(retainOldest(range(1, 10), HISTORY_LIMIT).length, 10);
});

test("a new message follows only while the reader is on the real tail", () => {
  assert.equal(shouldFollowTail(0, true), true);
  assert.equal(shouldFollowTail(99, true), true);
  assert.equal(shouldFollowTail(100, true), false);
  assert.equal(shouldFollowTail(0, false), false);

  const reading = applyMemoryCap([...range(1, 40), message("live", 41)], false);
  assert.equal(reading.droppedTail, false);
  assert.equal(reading.messages.at(-1)?.id, "live");
  assert.equal(shouldFollowTail(240, true), false);
});
