import assert from "node:assert/strict";
import test from "node:test";
import { inlineTokens } from "./inlineTokens";

test("inline tokens follow raft ref rules for channels, threads, and tasks", () => {
  const tokens = inlineTokens(
    "hey @Ada see (#general) #bug:fix #123 #all:ab12cd",
    [{ name: "Ada", id: "me", type: "user" }],
    "me",
  );
  assert.equal(tokens.find((token) => token.kind === "mention" && token.text === "@Ada")?.kind, "mention");
  assert.equal(tokens.some((token) => token.kind === "thread" && token.text.includes("bug")), false);
  assert.deepEqual(
    tokens.filter((token) => token.kind !== "text").map((token) => `${token.kind}:${token.text}`),
    ["mention:@Ada", "channel:#general", "channel:#bug", "task:#123", "thread:#all:ab12cd"],
  );
});
