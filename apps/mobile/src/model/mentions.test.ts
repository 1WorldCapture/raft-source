import assert from "node:assert/strict";
import test from "node:test";
import { mentionSegments } from "./mentions.ts";

test("mentionSegments highlights a resolved handle and stops before a word character", () => {
  assert.deepEqual(
    mentionSegments("hey @LocalDev please", [{ name: "LocalDev", type: "agent", id: "1" }]),
    [
      { text: "hey ", mention: false },
      { text: "@LocalDev", mention: true },
      { text: " please", mention: false },
    ],
  );
  assert.deepEqual(
    mentionSegments("@LocalDev-extra", [{ name: "LocalDev", id: "1" }]),
    [{ text: "@LocalDev-extra", mention: false }],
  );
});

test("mentionSegments leaves an email-like token alone when it is not a listed mention", () => {
  assert.equal(mentionSegments("a@b.c", [{ name: "Other" }])[0]?.mention, false);
});
