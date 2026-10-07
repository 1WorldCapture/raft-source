import { isRecord } from "../model/messages";

export interface InboxRow {
  id: string;
  kind: "channel" | "dm" | "thread" | "mention_action";
  title: string;
  channelId: string;
  channelName: string;
  parentChannelId?: string;
  parentMessageId?: string;
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
  if (!isRecord(item)) return [];
  const kind = typeof item.kind === "string" ? item.kind : typeof item.type === "string" ? item.type : "";
  if (kind === "thread") {
    if (typeof item.threadChannelId !== "string") return [];
    return [{
      id: item.threadChannelId,
      kind: "thread",
      title: text(item.latestActivityPreview) || text(item.parentChannelName) || item.threadChannelId,
      channelId: item.threadChannelId,
      channelName: text(item.parentChannelName) || "",
      parentChannelId: typeof item.parentChannelId === "string" ? item.parentChannelId : undefined,
      parentMessageId: typeof item.parentMessageId === "string" ? item.parentMessageId : undefined,
    }];
  }
  if (kind === "mention_action") {
    if (typeof item.channelId !== "string" || typeof item.id !== "string") return [];
    return [{
      id: item.id,
      kind: "mention_action",
      title: text(item.messagePreview) || text(item.channelName) || item.channelId,
      channelId: item.channelId,
      channelName: text(item.channelName) || "",
    }];
  }
  if (kind !== "channel" && kind !== "dm") return [];
  if (typeof item.channelId !== "string") return [];
  return [{
    id: item.channelId,
    kind,
    title: text(item.lastMessagePreview) || text(item.channelName) || item.channelId,
    channelId: item.channelId,
    channelName: text(item.channelName) || "",
  }];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
