import assert from "node:assert/strict";
import test from "node:test";
import { parseInbox } from "./inbox";

test("parseInbox uses inbox fields and the unread total", () => {
  const parsed = parseInbox({
    totalUnreadCount: 4,
    items: [
      { kind: "channel", channelId: "all", channelName: "all", lastMessagePreview: "hello" },
      { kind: "dm", channelId: "dm-1", channelName: "Ada", lastMessagePreview: "ping" },
      {
        kind: "thread",
        threadChannelId: "thread-1",
        parentChannelId: "all",
        parentMessageId: "message-1",
        parentChannelName: "all",
        latestActivityPreview: "reply",
      },
    ],
  });
  assert.equal(parsed.totalUnreadCount, 4);
  assert.deepEqual(parsed.rows.map((row) => [row.kind, row.title, row.channelId]), [
    ["channel", "hello", "all"],
    ["dm", "ping", "dm-1"],
    ["thread", "reply", "thread-1"],
  ]);
  assert.equal(parsed.rows[2]?.parentChannelId, "all");
  assert.equal(parsed.rows[2]?.parentMessageId, "message-1");
});

test("parseInbox does not use the row index as a title", () => {
  const parsed = parseInbox({ items: [{ kind: "channel" }, { title: "ignored" }] });
  assert.equal(parsed.totalUnreadCount, 0);
  assert.deepEqual(parsed.rows, []);
});
