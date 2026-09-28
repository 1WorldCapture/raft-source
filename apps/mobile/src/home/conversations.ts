// Conversation-list data layer for the message-list home (task #2).
//
// Pure functions only: merging channels and DMs into one list sorted by
// latest activity, the unread filter, and the realtime merge of `message:new`
// events. The screen keeps no ordering logic of its own; the zustand store
// wraps these (setConversations / applyLiveToConversations) so home renders
// straight from state and never reloads the whole list on tab focus.
import { buildMessagePreview, type MessagePreview } from "@botiverse/raft-shared/src/messageSnippet.ts";
import { channelLabel, type ChannelUnreadEntry, type RaftChannel, type RaftMessage } from "../model/messages";

export interface ConversationEntry {
  channel: RaftChannel;
  preview: MessagePreview | null;
}

export type ConversationUnreadMap = Record<string, ChannelUnreadEntry | undefined>;
export type LiveUnreadMap = Record<string, number | undefined>;

function activityTime(entry: ConversationEntry): number {
  const parsed = entry.channel.lastMessageAt ? Date.parse(entry.channel.lastMessageAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareEntries(a: ConversationEntry, b: ConversationEntry): number {
  const aTime = activityTime(a);
  const bTime = activityTime(b);
  // Conversations with any message come first, newest first; the rest sit at
  // the bottom sorted by display name so they stay findable (lyonliang's
  // "everything visible" requirement).
  if ((aTime > 0) !== (bTime > 0)) return aTime > 0 ? -1 : 1;
  if (aTime > 0 && aTime !== bTime) return bTime - aTime;
  const aLabel = channelLabel(a.channel);
  const bLabel = channelLabel(b.channel);
  if (aLabel !== bLabel) return aLabel < bLabel ? -1 : 1;
  return a.channel.id < b.channel.id ? -1 : 1;
}

/** Merge every joined channel and DM into one list sorted by latest activity. */
export function buildConversations(channels: RaftChannel[]): ConversationEntry[] {
  return channels
    .filter((channel) => channel.joined !== false && !channel.archivedAt && channel.type !== "thread")
    .map((channel) => ({ channel, preview: channel.lastMessagePreview ?? null }))
    .sort(compareEntries);
}

export function conversationUnreadCount(
  channelId: string,
  unread: ConversationUnreadMap,
  live: LiveUnreadMap,
): number {
  return (unread[channelId]?.unreadCount ?? 0) + (live[channelId] ?? 0);
}

/**「未读」filter: unread count or an unread mention keeps the row. */
export function filterUnreadConversations(
  entries: ConversationEntry[],
  unread: ConversationUnreadMap,
  live: LiveUnreadMap,
): ConversationEntry[] {
  return entries.filter((entry) => (
    conversationUnreadCount(entry.channel.id, unread, live) > 0
    || unread[entry.channel.id]?.hasMention === true
  ));
}

/**
 * Full refresh: the freshly fetched channels are authoritative — conversations
 * that disappeared server-side (left, archived) are dropped, live-only reorderings
 * are superseded. Rebuilt and re-sorted from scratch, like buildConversations.
 */
export function replaceConversations(_current: ConversationEntry[], freshChannels: RaftChannel[]): ConversationEntry[] {
  return buildConversations(freshChannels);
}

/**
 * Merge one live `message:new` into the list. Thread replies arrive with the
 * thread channel's id, which is never a conversation entry, so they fall out
 * naturally (contract: threads do not update the conversation list). Duplicate
 * deliveries (same message id) and late, out-of-order events are ignored; a
 * newer message moves its conversation to the front and refreshes
 * lastMessageAt + preview with the exact shared algorithm the server used.
 */
export function applyLiveMessage(entries: ConversationEntry[], message: RaftMessage): { entries: ConversationEntry[]; changed: boolean } {
  const index = entries.findIndex((entry) => entry.channel.id === message.channelId);
  if (index === -1) return { entries, changed: false };
  const current = entries[index];
  if (current.preview?.messageId === message.id) return { entries, changed: false };

  const incomingTime = message.createdAt ? Date.parse(message.createdAt) : NaN;
  const currentTime = activityTime(current);
  if (Number.isFinite(incomingTime) && incomingTime < currentTime) return { entries, changed: false };

  const preview = buildMessagePreview({
    messageId: message.id,
    messageType: message.messageType ?? "",
    content: message.content,
    senderType: message.senderType ?? "user",
    senderId: message.senderId ?? null,
    senderName: message.senderDisplayName || message.senderName || null,
    taskNumber: message.taskNumber ?? null,
    attachments: message.attachments?.map((attachment) => ({ mimeType: attachment.mimeType ?? null })) ?? null,
  });
  const updated: ConversationEntry = {
    channel: { ...current.channel, lastMessageAt: message.createdAt ?? current.channel.lastMessageAt },
    preview,
  };
  const rest = entries.filter((_, i) => i !== index);
  if (Number.isFinite(incomingTime) && incomingTime > currentTime) {
    return { entries: [updated, ...rest], changed: true };
  }
  rest.splice(index, 0, updated);
  return { entries: rest, changed: true };
}
