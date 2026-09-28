import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePreview } from "@botiverse/raft-shared/src/messageSnippet.ts";
import type { RaftChannel, RaftMessage } from "../model/messages.ts";
import {
  applyLiveMessage,
  buildConversations,
  conversationUnreadCount,
  filterUnreadConversations,
  replaceConversations,
  shouldRefreshForUnknownChannel,
} from "./conversations.ts";

function channel(overrides: Partial<RaftChannel> = {}): RaftChannel {
  return { id: "c1", name: "channel-one", type: "channel", lastMessageAt: null, ...overrides };
}

function preview(overrides: Partial<MessagePreview> = {}): MessagePreview {
  return {
    messageId: "m1",
    kind: "text",
    text: "hello",
    senderType: "user",
    senderId: "u1",
    senderName: "Lyon",
    attachmentCount: 0,
    taskNumber: null,
    ...overrides,
  };
}

function liveMessage(overrides: Partial<RaftMessage> = {}): RaftMessage {
  return {
    id: "m2",
    channelId: "c1",
    content: "fresh message",
    senderType: "agent",
    senderId: "a1",
    senderName: "Firstmate",
    createdAt: "2026-09-28T02:00:00.000Z",
    ...overrides,
  };
}

test("buildConversations sorts by latest activity, message-less at the bottom by name", () => {
  const entries = buildConversations([
    channel({ id: "old-b", name: "zeta", lastMessageAt: null }),
    channel({ id: "newest", name: "alpha", lastMessageAt: "2026-09-28T03:00:00.000Z" }),
    channel({ id: "old-a", name: "beta", lastMessageAt: null }),
    channel({ id: "middle", name: "gamma", lastMessageAt: "2026-09-28T02:00:00.000Z" }),
    channel({ id: "dm", name: "dm-slot", type: "dm", peerDisplayName: "Anna", lastMessageAt: "2026-09-28T02:30:00.000Z" }),
  ]);
  assert.deepEqual(entries.map((entry) => entry.channel.id), ["newest", "dm", "middle", "old-a", "old-b"]);
});

test("buildConversations keeps DMs and channels in one list and drops left/archived/thread channels", () => {
  const entries = buildConversations([
    channel({ id: "kept" }),
    channel({ id: "left", joined: false }),
    channel({ id: "gone", archivedAt: "2026-09-01T00:00:00.000Z" }),
    channel({ id: "threadish", type: "thread" }),
  ]);
  assert.deepEqual(entries.map((entry) => entry.channel.id), ["kept"]);
});

test("same timestamp falls back to a deterministic name then id order", () => {
  const entries = buildConversations([
    channel({ id: "b", name: "same", lastMessageAt: "2026-09-28T01:00:00.000Z" }),
    channel({ id: "a", name: "same", lastMessageAt: "2026-09-28T01:00:00.000Z" }),
    channel({ id: "c", name: "earlier-name", lastMessageAt: "2026-09-28T01:00:00.000Z" }),
  ]);
  assert.deepEqual(entries.map((entry) => entry.channel.id), ["c", "a", "b"]);
});

test("previews ride along from the parsed channel field", () => {
  const entries = buildConversations([
    channel({ id: "with", lastMessageAt: "2026-09-28T01:00:00.000Z", lastMessagePreview: preview({ text: "ride" }) }),
    channel({ id: "without", lastMessageAt: null, lastMessagePreview: null }),
  ]);
  assert.equal(entries[0].preview?.text, "ride");
  assert.equal(entries[1].preview, null);
});

test("unread filter keeps unread counts, live bumps and mentions", () => {
  const entries = buildConversations([
    channel({ id: "plain", lastMessageAt: "2026-09-28T03:00:00.000Z" }),
    channel({ id: "server-unread", lastMessageAt: "2026-09-28T02:00:00.000Z" }),
    channel({ id: "live-unread", lastMessageAt: "2026-09-28T01:00:00.000Z" }),
    channel({ id: "mention-only", lastMessageAt: "2026-09-28T00:30:00.000Z" }),
  ]);
  const unread = {
    "server-unread": { unreadCount: 3, hasMention: false },
    "mention-only": { unreadCount: 0, hasMention: true },
  };
  const live = { "live-unread": 1 };
  assert.deepEqual(
    filterUnreadConversations(entries, unread, live).map((entry) => entry.channel.id),
    ["server-unread", "live-unread", "mention-only"],
  );
  assert.equal(conversationUnreadCount("server-unread", unread, live), 3);
  assert.equal(conversationUnreadCount("live-unread", unread, live), 1);
  assert.equal(conversationUnreadCount("plain", unread, live), 0);
});

test("a newer live message moves its conversation to the front with a fresh preview", () => {
  const entries = buildConversations([
    channel({ id: "c1", lastMessageAt: "2026-09-28T01:00:00.000Z", lastMessagePreview: preview({ messageId: "m1" }) }),
    channel({ id: "c2", lastMessageAt: "2026-09-28T02:00:00.000Z" }),
  ]);
  const result = applyLiveMessage(entries, liveMessage({ channelId: "c1", id: "m9", createdAt: "2026-09-28T04:00:00.000Z" }));
  assert.equal(result.changed, true);
  assert.deepEqual(result.entries.map((entry) => entry.channel.id), ["c1", "c2"]);
  assert.equal(result.entries[0].channel.lastMessageAt, "2026-09-28T04:00:00.000Z");
  assert.equal(result.entries[0].preview?.messageId, "m9");
  assert.equal(result.entries[0].preview?.text, "fresh message");
  assert.equal(result.entries[0].preview?.senderName, "Firstmate");
});

test("duplicate delivery of the same message is a no-op", () => {
  const entries = buildConversations([
    channel({ id: "c1", lastMessageAt: "2026-09-28T04:00:00.000Z", lastMessagePreview: preview({ messageId: "m9", text: "fresh message" }) }),
  ]);
  const result = applyLiveMessage(entries, liveMessage({ channelId: "c1", id: "m9", createdAt: "2026-09-28T04:00:00.000Z" }));
  assert.equal(result.changed, false);
  assert.equal(result.entries, entries);
});

test("late, out-of-order events do not reorder or rewrite the list", () => {
  const entries = buildConversations([
    channel({ id: "c1", lastMessageAt: "2026-09-28T04:00:00.000Z", lastMessagePreview: preview({ messageId: "m9" }) }),
    channel({ id: "c2", lastMessageAt: "2026-09-28T02:00:00.000Z" }),
  ]);
  const result = applyLiveMessage(entries, liveMessage({ channelId: "c1", id: "m8", createdAt: "2026-09-28T03:00:00.000Z", content: "stale" }));
  assert.equal(result.changed, false);
  assert.equal(result.entries, entries);
});

test("thread and unknown channels are ignored; equal timestamps update in place", () => {
  const entries = buildConversations([
    channel({ id: "c1", lastMessageAt: "2026-09-28T04:00:00.000Z", lastMessagePreview: preview({ messageId: "m9" }) }),
    channel({ id: "c2", lastMessageAt: "2026-09-28T05:00:00.000Z" }),
  ]);
  const thread = applyLiveMessage(entries, liveMessage({ channelId: "thread-1", id: "m10", createdAt: "2026-09-28T06:00:00.000Z" }));
  assert.equal(thread.changed, false);

  const equal = applyLiveMessage(entries, liveMessage({ channelId: "c1", id: "m10", createdAt: "2026-09-28T04:00:00.000Z", content: "same instant" }));
  assert.equal(equal.changed, true);
  assert.deepEqual(equal.entries.map((entry) => entry.channel.id), ["c2", "c1"], "keeps position on equal timestamps (c2 is newer and stays first)");
  assert.equal(equal.entries[1].preview?.text, "same instant");
});

test("live preview classification matches the shared contract", () => {
  const entries = buildConversations([channel({ id: "c1", lastMessageAt: "2026-09-28T01:00:00.000Z" })]);
  const image = applyLiveMessage(entries, liveMessage({
    content: "",
    attachments: [{ filename: "a.png", mimeType: "image/png" }, { filename: "b.png", mimeType: "image/png" }],
  })).entries[0].preview;
  assert.equal(image?.kind, "image");
  assert.equal(image?.attachmentCount, 2);

  const task = applyLiveMessage(entries, liveMessage({ content: "修复登录 401", taskNumber: 16 })).entries[0].preview;
  assert.equal(task?.kind, "task");
  assert.equal(task?.taskNumber, 16);

  const markdown = applyLiveMessage(entries, liveMessage({ content: "**Done** with `step 1` <@Anna> see [the PR](https://x)" })).entries[0].preview;
  assert.equal(markdown?.kind, "text");
  assert.equal(markdown?.text, "Done with step 1 @Anna see the PR");
});

test("replaceConversations treats a full refresh as authoritative", () => {
  const current = buildConversations([
    channel({ id: "stale", lastMessageAt: "2026-09-28T03:00:00.000Z" }),
  ]);
  const fresh = replaceConversations(current, [
    channel({ id: "kept", lastMessageAt: "2026-09-28T02:00:00.000Z" }),
    channel({ id: "new", lastMessageAt: "2026-09-28T05:00:00.000Z" }),
  ]);
  assert.deepEqual(fresh.map((entry) => entry.channel.id), ["new", "kept"], "re-sorted, stale row dropped");
});

test("unknown-channel refresh only fires for listed-conversation types the list has never seen", () => {
  const listed = new Set(["c1"]);
  // Thread replies must never trigger a refresh (the list never contains threads).
  assert.equal(shouldRefreshForUnknownChannel({ channelId: "thread-1", conversationChannelType: "thread" }, listed), false);
  // Missing conversationContext (older server): conservative, no refresh.
  assert.equal(shouldRefreshForUnknownChannel({ channelId: "dm-new", conversationChannelType: undefined }, listed), false);
  // A brand-new DM/channel/joint conversation is unknown and refreshable.
  assert.equal(shouldRefreshForUnknownChannel({ channelId: "dm-new", conversationChannelType: "dm" }, listed), true);
  assert.equal(shouldRefreshForUnknownChannel({ channelId: "ch-new", conversationChannelType: "channel" }, listed), true);
  assert.equal(shouldRefreshForUnknownChannel({ channelId: "j-new", conversationChannelType: "joint" }, listed), true);
  assert.equal(shouldRefreshForUnknownChannel({ channelId: "p-new", conversationChannelType: "private" }, listed), true);
  // Already-listed channels never trigger it, whatever the type says.
  assert.equal(shouldRefreshForUnknownChannel({ channelId: "c1", conversationChannelType: "channel" }, listed), false);
});
