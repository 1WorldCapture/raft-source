import { isRecord } from "../model/messages";

export interface InboxRow {
  id: string;
  title: string;
  channelId: string;
  channelName: string;
}

export function parseInbox(data: unknown): { totalUnreadCount: number; rows: InboxRow[] } {
  if (!isRecord(data)) return { totalUnreadCount: 0, rows: [] };
  const totalUnreadCount = typeof data.totalUnreadCount === "number" && data.totalUnreadCount > 0
    ? Math.floor(data.totalUnreadCount)
    : 0;
  const items = Array.isArray(data.items) ? data.items : [];
  return { totalUnreadCount, rows: items.flatMap(parseInboxItem) };
}

function parseInboxItem(item: unknown): InboxRow[] {
  if (!isRecord(item) || typeof item.kind !== "string") return [];
  if (item.kind === "thread") {
    if (typeof item.threadChannelId !== "string") return [];
    return [{
      id: item.threadChannelId,
      title: text(item.latestActivityPreview) || text(item.parentChannelName) || item.threadChannelId,
      channelId: item.threadChannelId,
      channelName: text(item.parentChannelName) || "",
    }];
  }
  if (item.kind === "mention_action") {
    if (typeof item.channelId !== "string" || typeof item.id !== "string") return [];
    return [{
      id: item.id,
      title: text(item.messagePreview) || text(item.channelName) || item.channelId,
      channelId: item.channelId,
      channelName: text(item.channelName) || "",
    }];
  }
  if (item.kind !== "channel" && item.kind !== "dm") return [];
  if (typeof item.channelId !== "string") return [];
  return [{
    id: item.channelId,
    title: text(item.lastMessagePreview) || text(item.channelName) || item.channelId,
    channelId: item.channelId,
    channelName: text(item.channelName) || "",
  }];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
