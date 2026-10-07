import assert from "node:assert/strict";
import test from "node:test";
import type { RaftMessage } from "../model/messages";
import { actorNames, applyReaction } from "./reactions";

const message: RaftMessage = { id: "m1", channelId: "c1", content: "hi", reactions: [{ emoji: "👍", count: 1, reactedByMe: false, userIds: ["other"] }] };

test("applyReaction adds and removes the viewer's reaction without dropping other people", () => {
  const added = applyReaction(message, "👍", true, "me");
  assert.equal(added.reactions?.[0]?.count, 2);
  assert.equal(added.reactions?.[0]?.reactedByMe, true);
  const removed = applyReaction(added, "👍", false, "me");
  assert.equal(removed.reactions?.[0]?.count, 1);
  assert.equal(removed.reactions?.[0]?.reactedByMe, false);
  assert.deepEqual(removed.reactions?.[0]?.userIds, ["other"]);
});

test("actorNames reads display names from the actors payload", () => {
  assert.deepEqual(actorNames({ actors: [{ displayName: "Ada" }, { name: "Bot" }, { id: "x" }] }), ["Ada", "Bot"]);
  assert.deepEqual(actorNames(null), []);
});

test("applyReaction drops an emoji once its count reaches zero", () => {
  const mine: RaftMessage = { id: "m1", channelId: "c1", content: "hi", reactions: [{ emoji: "✅", count: 1, reactedByMe: true, userIds: ["me"] }] };
  assert.deepEqual(applyReaction(mine, "✅", false, "me").reactions, []);
});
