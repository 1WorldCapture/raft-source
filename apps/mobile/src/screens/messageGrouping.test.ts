import assert from "node:assert/strict";
import test from "node:test";
import { computeMessageGrouping, type GroupableMessage } from "./messageGrouping";

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
