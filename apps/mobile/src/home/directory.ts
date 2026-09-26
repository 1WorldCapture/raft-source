import { isRecord, type RaftChannel } from "../model/messages";

export interface HomeGroups {
  pinned: RaftChannel[];
  joint: RaftChannel[];
  channels: RaftChannel[];
  dms: RaftChannel[];
}

/** Pinned ids from `GET /servers/:id/sidebar-order`. Custom section order is not applied. */
export function pinnedChannelIds(data: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isRecord(data)) return ids;
  if (Array.isArray(data.pinnedChannelIds)) {
    for (const id of data.pinnedChannelIds) if (typeof id === "string") ids.add(id);
  }
  if (Array.isArray(data.pinned)) {
    for (const item of data.pinned) {
      if (typeof item === "string") ids.add(item);
      else if (isRecord(item)) {
        const id = item.channelId ?? item.id;
        if (typeof id === "string" && item.type !== "agent") ids.add(id);
      }
    }
  }
  return ids;
}

export function groupHomeChannels(channels: RaftChannel[], pinned: Set<string>): HomeGroups {
  const groups: HomeGroups = { pinned: [], joint: [], channels: [], dms: [] };
  for (const channel of channels) {
    if (channel.joined === false || channel.archivedAt || channel.type === "thread") continue;
    if (pinned.has(channel.id)) {
      groups.pinned.push(channel);
      continue;
    }
    if (channel.type === "dm") groups.dms.push(channel);
    else if (channel.type === "joint") groups.joint.push(channel);
    else groups.channels.push(channel);
  }
  return groups;
}

export function groupHasUnread(
  channels: RaftChannel[],
  unread: Record<string, { unreadCount: number; hasMention: boolean } | undefined>,
  live: Record<string, number | undefined>,
): boolean {
  return channels.some((channel) => {
    const summary = unread[channel.id];
    return (summary?.unreadCount ?? 0) + (live[channel.id] ?? 0) > 0 || summary?.hasMention === true;
  });
}
