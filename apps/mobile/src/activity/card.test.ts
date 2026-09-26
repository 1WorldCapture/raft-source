import assert from "node:assert/strict";
import test from "node:test";
import { color } from "../ui/tokens";
import type { ActivityItem } from "./model";
import {
  activityBadges,
  activityBodyPreview,
  activityEmptyCopy,
  activityMenuActions,
  activityPrimaryText,
  activitySender,
  activityTargetMessageId,
  activityThreadTag,
  nextNewUpdateCount,
  nextUnreadKey,
  showMarkAllRead,
  taskStatusFill,
} from "./card";

const channel: ActivityItem = {
  kind: "channel",
  channelId: "all",
  channelName: "#all",
  channelType: "channel",
  lastMessageId: "m1",
  firstUnreadMessageId: "m1",
  firstMentionMessageId: null,
  lastMessageAt: "2026-09-26T00:00:00.000Z",
  lastMessagePreview: "hello",
  lastMessageSenderType: "user",
  lastMessageSenderId: "u1",
  lastMessageSenderName: "Raw",
  unreadCount: 2,
  hasMention: true,
  doneFrontierSeq: "15",
};

const thread: ActivityItem = {
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
  latestActivitySenderName: "bot",
  latestActivityMessageId: "m2",
  firstUnreadMessageId: null,
  firstMentionMessageId: null,
  lastActivityAt: "2026-09-26T00:00:00.000Z",
  replyCount: 4,
  unreadCount: 0,
  hasMention: false,
  taskNumber: 12,
  taskStatus: "in_progress",
  taskClaimedByName: "Ada",
  isFollowing: false,
};

test("thread tag, primary text, and preview follow the web card", () => {
  assert.equal(activityThreadTag(thread), "#all");
  assert.equal(activityThreadTag({ ...thread, parentChannelType: "dm", parentChannelName: "@Ada" }), "@Ada");
  assert.equal(activityThreadTag(channel), null);
  assert.equal(activityPrimaryText(channel), "all");
  assert.equal(activityPrimaryText(thread), "topic");
  assert.equal(activityBodyPreview(thread), "reply");
  assert.equal(activityBodyPreview(channel), "hello");
});

test("sender names prefer the directory and system rows stay localized", () => {
  assert.deepEqual(activitySender(channel, { u1: "Ada" }), { system: false, name: "Ada" });
  assert.deepEqual(activitySender(channel, {}), { system: false, name: "Raw" });
  assert.deepEqual(activitySender({ ...channel, lastMessageSenderId: "system", lastMessageSenderType: "user" }, { system: "System" }), { system: true, name: null });
  assert.deepEqual(activitySender({ ...thread, latestActivitySenderType: "system" }, {}), { system: true, name: null });
});

test("badges keep the web order and hide the mention chip on the mentions filter", () => {
  assert.deepEqual(activityBadges({ ...thread, unreadCount: 3, hasMention: true }, "all", true).map((badge) => badge.kind), [
    "task", "replies", "unfollowed", "mention", "unread", "draft",
  ]);
  const task = activityBadges(thread, "all", false)[0];
  assert.equal(task?.kind, "task");
  if (task?.kind === "task") assert.equal(task.text, "#12 @Ada");
  assert.deepEqual(activityBadges({ ...channel, unreadCount: 2, hasMention: true }, "mentions", false).map((badge) => badge.kind), ["unread"]);
  assert.deepEqual(activityBadges({ ...thread, isFollowing: true, taskNumber: null, taskStatus: null }, "done", false).map((badge) => badge.kind), ["replies"]);
});

test("mark-all-read is hidden when nothing is unread or the done filter is open", () => {
  assert.equal(showMarkAllRead("all", 3), true);
  assert.equal(showMarkAllRead("unread", 0), false);
  assert.equal(showMarkAllRead("done", 3), false);
});

test("empty copy and task fills follow the filter and status", () => {
  assert.equal(activityEmptyCopy("mentions").title, "thread.empty.mentionsTitle");
  assert.equal(activityEmptyCopy("unread").title, "thread.empty.unreadTitle");
  assert.equal(activityEmptyCopy("unread").description, "thread.empty.defaultDescription");
  assert.equal(activityEmptyCopy("done").title, "activity.current.emptyDone");
  assert.equal(activityEmptyCopy("all").title, "thread.empty.defaultTitle");
  assert.equal(taskStatusFill("todo"), color.orange);
  assert.equal(taskStatusFill("in_progress"), color.cyan);
  assert.equal(taskStatusFill("in_review"), color.lavender);
  assert.equal(taskStatusFill("done"), color.lime);
  assert.equal(taskStatusFill("closed"), color.stone);
  assert.equal(taskStatusFill("other"), color.orange);
});

test("opening a card prefers the mention, then the first unread, then the latest", () => {
  assert.equal(activityTargetMessageId({ ...thread, unreadCount: 2, firstUnreadMessageId: "unread-1" }), "unread-1");
  assert.equal(activityTargetMessageId({ ...thread, unreadCount: 2, firstUnreadMessageId: null }), "m2");
  assert.equal(activityTargetMessageId(thread), "m2");
  assert.equal(activityTargetMessageId({ ...channel, firstMentionMessageId: "mention-1", unreadCount: 0 }), "mention-1");
  assert.equal(activityTargetMessageId(channel), "m1");
  assert.equal(activityTargetMessageId({ ...channel, unreadCount: 0, firstUnreadMessageId: "old" }), "m1");
});

test("the long-press menu hides read on an unfollowed thread and adds follow", () => {
  assert.deepEqual(activityMenuActions(channel), ["read", "done"]);
  assert.deepEqual(activityMenuActions({ ...channel, unreadCount: 0 }), ["unread", "done"]);
  assert.deepEqual(activityMenuActions({ ...thread, isFollowing: true, unreadCount: 1 }), ["read", "done", "unfollow"]);
  assert.deepEqual(activityMenuActions(thread), ["done", "follow"]);
});

test("title double-tap cycles unread rows, and new updates wait until the list leaves the top", () => {
  const later = { ...channel, channelId: "later", unreadCount: 1 };
  const read = { ...channel, channelId: "read", unreadCount: 0 };
  assert.equal(nextUnreadKey([read, channel, later], null), "channel:all");
  assert.equal(nextUnreadKey([read, channel, later], "channel:all"), "channel:later");
  assert.equal(nextUnreadKey([read, channel, later], "channel:later"), "channel:all");
  assert.equal(nextUnreadKey([read], null), null);
  assert.equal(nextNewUpdateCount("a", "b", true, 2), 0);
  assert.equal(nextNewUpdateCount(null, "b", false, 0), 0);
  assert.equal(nextNewUpdateCount("a", "b", false, 1), 2);
});
