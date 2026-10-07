import assert from "node:assert/strict";
import test from "node:test";
import {
  activityUnreadByServer,
  applyMarkAllRead,
  applyMarkRead,
  applyReadState,
  doneRequest,
  mergeActivityItems,
  parseActivityPage,
  type ActivityItem,
  type ActivitySnapshot,
} from "./model";

const channel = {
  kind: "channel",
  channelId: "all",
  channelName: "all",
  channelType: "channel",
  lastMessageId: "m1",
  firstUnreadMessageId: "m1",
  firstMentionMessageId: null,
  lastMessageAt: "2026-09-26T00:00:00.000Z",
  lastMessagePreview: "hello",
  lastMessageSenderType: "user",
  lastMessageSenderId: "u1",
  lastMessageSenderName: "Ada",
  unreadCount: 2,
  hasMention: false,
  doneFrontierSeq: "15",
};

const thread = {
  kind: "thread",
  threadChannelId: "thread-1",
  parentMessageId: "parent-1",
  parentChannelId: "all",
  parentChannelName: "all",
  parentChannelType: "channel",
  parentMessagePreview: "topic",
  latestActivityPreview: "reply",
  latestActivitySenderType: "agent",
  latestActivitySenderId: "a1",
  latestActivitySenderName: "Firstmate",
  latestActivityMessageId: "m2",
  firstUnreadMessageId: "m2",
  firstMentionMessageId: "m2",
  lastActivityAt: "2026-09-26T00:01:00.000Z",
  replyCount: 3,
  unreadCount: 1,
  hasMention: true,
  taskNumber: 12,
  taskStatus: "todo",
  taskClaimedByName: "Ada",
  isFollowing: true,
  doneFrontierSeq: "9",
};

function page(items: ActivityItem[], filter: ActivitySnapshot["filter"] = "all"): ActivitySnapshot {
  const unread = items.reduce((sum, item) => sum + item.unreadCount, 0);
  return {
    items,
    hasMore: false,
    totalCount: items.length,
    totalUnreadCount: unread,
    activeUnreadCount: unread,
    filter,
  };
}

test("activity unread counts ignore a missing or illegal activity field", () => {
  assert.deepEqual(activityUnreadByServer([
    { serverId: "a", activityUnreadCount: 4 },
    { serverId: "b", unreadCount: 9 },
    { serverId: "c", activityUnreadCount: -1 },
  ]), { a: 4 });
});

test("parseActivityPage keeps channel, dm, and thread fields", () => {
  const parsed = parseActivityPage({
    items: [
      channel,
      { ...channel, kind: "dm", channelId: "dm-1", channelType: "dm", channelName: "Ada" },
      thread,
    ],
    hasMore: true,
    totalCount: 4,
    totalUnreadCount: 3.8,
    activeUnreadCount: 2,
  });
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.totalCount, 4);
  assert.equal(parsed.totalUnreadCount, 3);
  assert.equal(parsed.items[0]?.kind, "channel");
  assert.equal(parsed.items[1]?.kind, "dm");
  const parsedThread = parsed.items[2];
  assert.equal(parsedThread?.kind, "thread");
  if (parsedThread?.kind === "thread") {
    assert.equal(parsedThread.replyCount, 3);
    assert.equal(parsedThread.taskNumber, 12);
    assert.equal(parsedThread.isFollowing, true);
    assert.equal(parsedThread.doneFrontierSeq, "9");
  }
});

test("parseActivityPage drops mention actions, broken rows, and illegal numbers", () => {
  const parsed = parseActivityPage({
    items: [
      { kind: "mention_action", id: "x", channelId: "all" },
      { kind: "channel" },
      { kind: "thread", parentChannelId: "all" },
      { kind: "note", channelId: "all" },
      { ...channel, unreadCount: "2", hasMention: "yes", doneFrontierSeq: 4 },
    ],
  });
  assert.equal(parsed.items.length, 1);
  const row = parsed.items[0];
  assert.equal(row?.unreadCount, 0);
  assert.equal(row?.hasMention, false);
  assert.equal(row?.doneFrontierSeq, null);
  assert.equal(parsed.totalCount, 0);
});

test("parseActivityPage leaves an omitted frontier undefined", () => {
  const legacy = { ...channel };
  delete legacy.doneFrontierSeq;
  const parsed = parseActivityPage({ items: [legacy] });
  assert.equal(parsed.items[0] && Object.prototype.hasOwnProperty.call(parsed.items[0], "doneFrontierSeq"), false);
});

test("mergeActivityItems appends new rows and skips duplicates", () => {
  const first = parseActivityPage({ items: [channel] }).items;
  const second = parseActivityPage({
    items: [channel, { ...channel, kind: "dm", channelId: "dm-1" }],
  }).items;
  const merged = mergeActivityItems(first, second);
  assert.deepEqual(merged.map((item) => item.kind === "thread" ? item.threadChannelId : item.channelId), ["all", "dm-1"]);
});

test("mark read zeros a row, and the unread filter removes it", () => {
  const items = parseActivityPage({ items: [channel, thread] }).items;
  const all = applyMarkRead(page(items, "all"), "all");
  assert.equal(all.items.length, 2);
  assert.equal(all.items[0]?.unreadCount, 0);
  assert.equal(all.totalUnreadCount, 1);

  const unread = applyMarkRead(page(items, "unread"), "all");
  assert.equal(unread.items.length, 1);
  assert.equal(unread.items[0]?.kind, "thread");
  assert.equal(unread.totalCount, 1);
});

test("mark all read clears the unread filter", () => {
  const items = parseActivityPage({ items: [channel, thread] }).items;
  const cleared = applyMarkAllRead(page(items, "unread"));
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.totalUnreadCount, 0);
  assert.equal(cleared.totalCount, 0);
});

test("read_state events zero only the matching scope", () => {
  const items = parseActivityPage({ items: [channel, thread] }).items;
  const next = applyReadState(page(items), ["thread-1"]);
  assert.equal(next.items[0]?.unreadCount, 2);
  assert.equal(next.items[1]?.unreadCount, 0);
  assert.equal(next.totalUnreadCount, 2);
});

test("done request bodies cover a frontier, a missing frontier, and an illegal frontier", () => {
  const [withFrontier] = parseActivityPage({ items: [thread] }).items;
  const [legacy] = parseActivityPage({ items: [{ kind: "channel", channelId: "all", channelName: "all" }] }).items;
  const [illegal] = parseActivityPage({ items: [{ ...channel, doneFrontierSeq: "0" }] }).items;
  assert.ok(withFrontier && legacy && illegal);

  assert.deepEqual(doneRequest(withFrontier), {
    action: "post",
    path: "/channels/threads/done",
    body: { threadChannelId: "thread-1", throughActivitySeq: "9", frontierSpace: "storage" },
  });
  assert.deepEqual(doneRequest(legacy), {
    action: "post",
    path: "/channels/inbox/done",
    body: { channelId: "all" },
  });
  assert.deepEqual(doneRequest(illegal), { action: "refresh" });
});
