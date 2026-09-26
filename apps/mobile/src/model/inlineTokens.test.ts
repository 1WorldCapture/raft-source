import assert from "node:assert/strict";
import test from "node:test";
import { inlineTokens } from "./inlineTokens";

test("inline tokens mark self mentions and channel, thread, and task chips", () => {
  const tokens = inlineTokens(
    "hey @Ada see #all:ab12 and #all task #4",
    [{ name: "Ada", id: "me", type: "user" }],
    "me",
  );
  assert.deepEqual(tokens.map((token) => token.kind), ["text", "mention", "text", "thread", "text", "channel", "text", "task"]);
  assert.equal(tokens[1]?.kind === "mention" ? tokens[1].self : false, true);
});
