import assert from "node:assert/strict";
import test from "node:test";
import { computeMessageGrouping, hiddenSystemIds, systemRunHeads, type GroupableMessage } from "./messageGrouping";

function message(partial: Partial<GroupableMessage> & Pick<GroupableMessage, "id">): GroupableMessage {
  return { senderType: "user", senderId: "ada", createdAt: "2026-09-26T08:00:00.000Z", ...partial };
}

test("the same sender stays in one group across a gap, but not across a day", () => {
  const states = computeMessageGrouping([
    message({ id: "a", createdAt: "2026-09-26T08:00:00.000Z" }),
    message({ id: "b", createdAt: "2026-09-26T12:00:00.000Z" }),
    message({ id: "c", createdAt: "2026-09-27T01:00:00.000Z" }),
  ], { timeZone: "UTC" });
  assert.equal(states.get("b")?.showAvatar, false);
  assert.equal(states.get("c")?.isFirstInGroup, true);
  assert.equal(states.get("c")?.showDayDivider, true);
});

test("a threaded message stays in its own group, and system messages do not merge", () => {
  const states = computeMessageGrouping([
    message({ id: "a" }),
    message({ id: "thread" }),
    message({ id: "b" }),
    message({ id: "system", messageType: "system", senderId: "ada" }),
    message({ id: "after" }),
  ], { timeZone: "UTC", standaloneIds: new Set(["thread"]) });
  assert.equal(states.get("thread")?.showAvatar, true);
  assert.equal(states.get("b")?.isFirstInGroup, true);
  assert.equal(states.get("system")?.showAvatar, false);
  assert.equal(states.get("after")?.isFirstInGroup, true);
});

test("consecutive system messages collapse to the first row", () => {
  const heads = systemRunHeads([
    { id: "a", messageType: "chat" },
    { id: "s1", messageType: "system" },
    { id: "s2", messageType: "system" },
    { id: "s3", messageType: "system" },
    { id: "b", messageType: "chat" },
  ]);
  assert.equal(heads.get("s1"), 3);
  assert.equal(heads.has("s2"), false);
  const hidden = hiddenSystemIds([
    { id: "a", messageType: "chat" },
    { id: "s1", messageType: "system" },
    { id: "s2", messageType: "system" },
    { id: "s3", messageType: "system" },
  ], new Set());
  assert.deepEqual([...hidden], ["s2", "s3"]);
  assert.equal(hiddenSystemIds([
    { id: "s1", messageType: "system" },
    { id: "s2", messageType: "system" },
  ], new Set(["s1"])).size, 0);
});
