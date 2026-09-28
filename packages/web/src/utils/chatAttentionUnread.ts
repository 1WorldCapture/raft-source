export interface ChatAttentionChannel {
  id: string;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  joined?: boolean;
}

/**
 * Chat's pink rail attention follows the conversation list the user owns:
 * DMs and joined channels. Public discovery rows keep their gray row-level
 * unread state, but an unjoined public channel must not light the global Chat
 * entry.
 */
export function selectChatAttentionChannelIds(
  channels: readonly ChatAttentionChannel[],
  dmChannels: readonly Pick<ChatAttentionChannel, "id">[],
): string[] {
  return [
    ...channels
      .filter((channel) => channel.type !== "channel" || channel.joined === true)
      .map((channel) => channel.id),
    ...dmChannels.map((channel) => channel.id),
  ];
}

export function hasChatAttentionUnread(
  channelIds: readonly string[],
  unreadCounts: Readonly<Record<string, number>>,
): boolean {
  return channelIds.some((channelId) => (unreadCounts[channelId] ?? 0) > 0);
}

/**
 * Numeric form of hasChatAttentionUnread: the sum over attention channels
 * only. The desktop dock badge uses this so its number matches what the
 * in-app Chat dot counts (unjoined discovery channels and other non-owned
 * rows never inflate it).
 */
export function chatAttentionUnreadTotal(
  channelIds: readonly string[],
  unreadCounts: Readonly<Record<string, number>>,
): number {
  let sum = 0;
  for (const channelId of channelIds) {
    const count = unreadCounts[channelId];
    if (count !== undefined && count > 0) sum += count;
  }
  return sum;
}
