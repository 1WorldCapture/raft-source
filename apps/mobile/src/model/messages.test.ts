import assert from "node:assert/strict";
import test from "node:test";
import { parseCreatedAt, parseMessage, mergeMessages } from "./messages.ts";

test("parseCreatedAt accepts a Postgres timestamp Hermes would reject", () => {
  assert.equal(parseCreatedAt("2026-09-25 19:01:14.059169-07"), "2026-09-26T02:01:14.059Z");
});

test("parseCreatedAt keeps an ISO timestamp stable", () => {
  assert.equal(parseCreatedAt("2026-09-25T19:01:14.059Z"), "2026-09-25T19:01:14.059Z");
});

test("parseMessage stores a Hermes-safe createdAt", () => {
  const message = parseMessage({
    id: "m1",
    channelId: "c1",
    content: "hi",
    createdAt: "2026-09-25 19:01:14.059169-07",
  });
  assert.equal(message?.createdAt, "2026-09-26T02:01:14.059Z");
  assert.equal(Number.isNaN(new Date(message?.createdAt ?? "").getTime()), false);
});

test("mergeMessages keeps an unsent row after messages that have a seq", () => {
  const merged = mergeMessages(
    [
      { id: "optimistic-1", channelId: "c1", content: "pending", seq: undefined },
      { id: "old", channelId: "c1", content: "old", seq: 2 },
    ],
    [{ id: "new", channelId: "c1", content: "new", seq: 9 }],
  );
  assert.deepEqual(merged.map((message) => message.id), ["old", "new", "optimistic-1"]);
});
