import assert from "node:assert/strict";
import test from "node:test";
import { isOwnBubble } from "./bubbleSide";

test("the signed-in user's messages sit on the right", () => {
  assert.equal(isOwnBubble({ senderType: "user", senderId: "me" }, "me"), true);
  assert.equal(isOwnBubble({ senderType: "user", senderId: "them" }, "me"), false);
  assert.equal(isOwnBubble({ senderType: "agent", senderId: "pm" }, "me"), false);
});

test("a local send with no sender id yet still sits on the right", () => {
  assert.equal(isOwnBubble({ pending: "sending" }, undefined), true);
  assert.equal(isOwnBubble({ pending: "failed", senderType: "user" }, "me"), true);
  assert.equal(isOwnBubble({ pending: "sending", senderType: "user", senderId: "me" }, "me"), true);
});

test("a pending row that already names someone else stays on the left", () => {
  assert.equal(isOwnBubble({ pending: "sending", senderType: "user", senderId: "them" }, "me"), false);
  assert.equal(isOwnBubble({ pending: "sending", senderType: "agent", senderId: "pm" }, "me"), false);
});
