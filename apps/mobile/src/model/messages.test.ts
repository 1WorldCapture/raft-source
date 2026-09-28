import assert from "node:assert/strict";
import test from "node:test";
import { parseCreatedAt, parseMessage, parseThreadSummaries, mergeMessages } from "./messages.ts";

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

test("thread preview times are normalized the same way as message times", () => {
  const summaries = parseThreadSummaries({
    threadSummariesByParentMessageId: {
      parent: {
        threadChannelId: "thread-1",
        replyCount: 1,
        latestReplies: [{
          messageId: "r1",
          preview: "hello",
          senderName: "Lyon",
          createdAt: "2026-09-26 01:58:28.486061-07",
        }],
      },
    },
  });
  assert.equal(summaries.parent?.latestReplies?.[0]?.createdAt, "2026-09-26T08:58:28.486Z");
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

test("parseCreatedAt normalizes pg-format timestamps (server sync endpoint shape)", async () => {
  const { parseCreatedAt } = await import("./messages.ts");
  // BackendDev finding (task #8): /messages/sync without channel_id emits
  // pg row timestamps like '2026-09-28 11:34:17.509+00'. Hermes only
  // guarantees ISO for Date.parse, so the normalizer must convert before
  // parsing — and already-stored caches carry this shape too.
  assert.equal(parseCreatedAt("2026-09-28 11:34:17.509+00"), "2026-09-28T11:34:17.509Z");
  assert.equal(parseCreatedAt("2026-09-28 11:34:17+00"), "2026-09-28T11:34:17.000Z");
  assert.equal(parseCreatedAt("2026-09-28 11:34:17.509123+00"), "2026-09-28T11:34:17.509Z");
  assert.equal(parseCreatedAt("2026-09-28 11:34:17.509+08"), "2026-09-28T03:34:17.509Z");
  assert.equal(parseCreatedAt("2026-09-28T11:34:17.509Z"), "2026-09-28T11:34:17.509Z");
  // Unparseable input falls back to the original string, never throws.
  assert.equal(parseCreatedAt("not a date"), "not a date");
});
