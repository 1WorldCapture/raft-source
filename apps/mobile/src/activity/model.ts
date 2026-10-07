import { isRecord } from "../model/messages";

export type ActivityFilter = "all" | "unread" | "mentions" | "done";
export type ActivityChannelType = "channel" | "private" | "joint" | "dm";
export type ActivitySenderType = "user" | "agent" | "system" | "external_projection";

interface ActivityBase {
  unreadCount: number;
  hasMention: boolean;
  /** Omitted on older servers. `null` means the field arrived but is not usable. */
  doneFrontierSeq?: string | null;
  firstUnreadMessageId: string | null;
  firstMentionMessageId: string | null;
}

export interface ChannelActivity extends ActivityBase {
  kind: "channel" | "dm";
  channelId: string;
  channelName: string;
  channelType: ActivityChannelType;
  lastMessageId: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageSenderType: ActivitySenderType;
  lastMessageSenderId: string;
  lastMessageSenderName: string | null;
}

export interface ThreadActivity extends ActivityBase {
  kind: "thread";
  threadChannelId: string;
  parentMessageId: string;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: ActivityChannelType;
  parentMessagePreview: string;
  latestActivityPreview: string;
  latestActivitySenderType: ActivitySenderType;
  latestActivitySenderId: string;
  latestActivitySenderName: string | null;
  latestActivityMessageId: string;
  lastActivityAt: string;
  replyCount: number;
  taskNumber: number | null;
  taskStatus: string | null;
  taskClaimedByName: string | null;
  isFollowing?: boolean;
}

export type ActivityItem = ChannelActivity | ThreadActivity;

export interface ActivityPage {
  items: ActivityItem[];
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
}

export interface ActivitySnapshot {
  items: ActivityItem[];
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
  filter: ActivityFilter;
}

const CHANNEL_TYPES = new Set<ActivityChannelType>(["channel", "private", "joint", "dm"]);
const SENDER_TYPES = new Set<ActivitySenderType>(["user", "agent", "system", "external_projection"]);
const POSITIVE_SEQ = /^[1-9][0-9]*$/;

export function activityScopeId(item: ActivityItem): string {
  return item.kind === "thread" ? item.threadChannelId : item.channelId;
}

export function activityKey(item: ActivityItem): string {
  return `${item.kind}:${activityScopeId(item)}`;
}

export function activityUnreadByServer(data: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(data)) return counts;
  for (const row of data) {
    if (!isRecord(row) || typeof row.serverId !== "string") continue;
    const count = row.activityUnreadCount;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) continue;
    counts[row.serverId] = count;
  }
  return counts;
}

export function activityTitle(item: ActivityItem): string {
  if (item.kind === "thread") return item.latestActivityPreview || item.parentChannelName || item.threadChannelId;
  return item.lastMessagePreview || item.channelName || item.channelId;
}

export function parseActivityPage(data: unknown): ActivityPage {
  if (!isRecord(data)) {
    return { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0 };
  }
  const items = Array.isArray(data.items) ? data.items.flatMap(parseActivityItem) : [];
  return {
    items,
    hasMore: data.hasMore === true,
    totalCount: count(data.totalCount),
    totalUnreadCount: count(data.totalUnreadCount),
    activeUnreadCount: count(data.activeUnreadCount),
  };
}

export function mergeActivityItems(existing: readonly ActivityItem[], incoming: readonly ActivityItem[]): ActivityItem[] {
  const seen = new Set(existing.map(activityKey));
  const merged = [...existing];
  for (const item of incoming) {
    const key = activityKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function applyMarkRead(snapshot: ActivitySnapshot, scopeId: string): ActivitySnapshot {
  return clearUnread(snapshot, (item) => activityScopeId(item) === scopeId);
}

export function applyMarkAllRead(snapshot: ActivitySnapshot): ActivitySnapshot {
  return clearUnread(snapshot, (item) => item.unreadCount > 0);
}

export function applyReadState(snapshot: ActivitySnapshot, scopeIds: readonly string[]): ActivitySnapshot {
  const ids = new Set(scopeIds);
  return clearUnread(snapshot, (item) => ids.has(activityScopeId(item)));
}

export function applyMarkUnread(snapshot: ActivitySnapshot, scopeId: string): ActivitySnapshot {
  let added = 0;
  const items = snapshot.items.map((item) => {
    if (activityScopeId(item) !== scopeId || item.unreadCount > 0) return item;
    added += 1;
    return { ...item, unreadCount: 1 };
  });
  if (added === 0) return snapshot;
  return {
    ...snapshot,
    items,
    totalUnreadCount: snapshot.totalUnreadCount + added,
    activeUnreadCount: snapshot.activeUnreadCount + added,
  };
}

export function applyRemove(snapshot: ActivitySnapshot, scopeId: string): ActivitySnapshot {
  let removedUnread = 0;
  let removed = 0;
  const items = snapshot.items.filter((item) => {
    if (activityScopeId(item) !== scopeId) return true;
    removed += 1;
    removedUnread += item.unreadCount;
    return false;
  });
  if (removed === 0) return snapshot;
  return {
    ...snapshot,
    items,
    totalCount: Math.max(0, snapshot.totalCount - removed),
    totalUnreadCount: Math.max(0, snapshot.totalUnreadCount - removedUnread),
    activeUnreadCount: Math.max(0, snapshot.activeUnreadCount - removedUnread),
  };
}

export function applyFollow(snapshot: ActivitySnapshot, threadChannelId: string, following: boolean): ActivitySnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map((item) => (
      item.kind === "thread" && item.threadChannelId === threadChannelId
        ? { ...item, isFollowing: following }
        : item
    )),
  };
}

export type DoneRequest =
  | { action: "refresh" }
  | { action: "post"; path: string; body: Record<string, string> };

/** A missing frontier is the old-server path. A present but unusable frontier must not be sent. */
export function doneRequest(item: ActivityItem): DoneRequest {
  const frontier = item.doneFrontierSeq;
  const legacy = frontier === undefined;
  if (!legacy && (typeof frontier !== "string" || !POSITIVE_SEQ.test(frontier))) {
    return { action: "refresh" };
  }
  if (item.kind === "thread") {
    return {
      action: "post",
      path: "/channels/threads/done",
      body: legacy
        ? { threadChannelId: item.threadChannelId }
        : { threadChannelId: item.threadChannelId, throughActivitySeq: frontier, frontierSpace: "storage" },
    };
  }
  return {
    action: "post",
    path: "/channels/inbox/done",
    body: legacy
      ? { channelId: item.channelId }
      : { channelId: item.channelId, throughActivitySeq: frontier, frontierSpace: "storage" },
  };
}

function clearUnread(snapshot: ActivitySnapshot, matches: (item: ActivityItem) => boolean): ActivitySnapshot {
  let cleared = 0;
  let removed = 0;
  const unreadFilter = snapshot.filter === "unread";
  const items = snapshot.items.flatMap((item) => {
    if (!matches(item) || item.unreadCount <= 0) return [item];
    cleared += item.unreadCount;
    if (unreadFilter) {
      removed += 1;
      return [];
    }
    return [{ ...item, unreadCount: 0 }];
  });
  if (cleared === 0) return snapshot;
  return {
    ...snapshot,
    items,
    totalCount: unreadFilter ? Math.max(0, snapshot.totalCount - removed) : snapshot.totalCount,
    totalUnreadCount: Math.max(0, snapshot.totalUnreadCount - cleared),
    activeUnreadCount: Math.max(0, snapshot.activeUnreadCount - cleared),
  };
}

function parseActivityItem(item: unknown): ActivityItem[] {
  if (!isRecord(item)) return [];
  if (item.kind === "mention_action") return [];
  if (item.kind === "thread") return parseThread(item);
  if (item.kind === "channel" || item.kind === "dm") return parseChannel(item);
  return [];
}

function parseThread(item: Record<string, unknown>): ThreadActivity[] {
  if (typeof item.threadChannelId !== "string" || item.threadChannelId.length === 0) return [];
  const following = typeof item.isFollowing === "boolean" ? { isFollowing: item.isFollowing } : {};
  return [{
    kind: "thread",
    threadChannelId: item.threadChannelId,
    parentMessageId: text(item.parentMessageId),
    parentChannelId: text(item.parentChannelId),
    parentChannelName: text(item.parentChannelName),
    parentChannelType: channelType(item.parentChannelType, "channel"),
    parentMessagePreview: text(item.parentMessagePreview),
    latestActivityPreview: text(item.latestActivityPreview),
    latestActivitySenderType: senderType(item.latestActivitySenderType),
    latestActivitySenderId: text(item.latestActivitySenderId),
    latestActivitySenderName: nullableText(item.latestActivitySenderName),
    latestActivityMessageId: text(item.latestActivityMessageId),
    lastActivityAt: text(item.lastActivityAt),
    replyCount: count(item.replyCount),
    taskNumber: positiveInt(item.taskNumber),
    taskStatus: nullableText(item.taskStatus),
    taskClaimedByName: nullableText(item.taskClaimedByName),
    ...shared(item),
    ...following,
  }];
}

function parseChannel(item: Record<string, unknown>): ChannelActivity[] {
  if (typeof item.channelId !== "string" || item.channelId.length === 0) return [];
  const kind = item.kind === "dm" ? "dm" : "channel";
  return [{
    kind,
    channelId: item.channelId,
    channelName: text(item.channelName),
    channelType: channelType(item.channelType, kind === "dm" ? "dm" : "channel"),
    lastMessageId: text(item.lastMessageId),
    lastMessageAt: text(item.lastMessageAt),
    lastMessagePreview: text(item.lastMessagePreview),
    lastMessageSenderType: senderType(item.lastMessageSenderType),
    lastMessageSenderId: text(item.lastMessageSenderId),
    lastMessageSenderName: nullableText(item.lastMessageSenderName),
    ...shared(item),
  }];
}

function shared(item: Record<string, unknown>): ActivityBase {
  return {
    unreadCount: count(item.unreadCount),
    hasMention: item.hasMention === true,
    firstUnreadMessageId: nullableText(item.firstUnreadMessageId),
    firstMentionMessageId: nullableText(item.firstMentionMessageId),
    ...frontier(item),
  };
}

function frontier(item: Record<string, unknown>): { doneFrontierSeq?: string | null } {
  if (!Object.prototype.hasOwnProperty.call(item, "doneFrontierSeq")) return {};
  const value = item.doneFrontierSeq;
  if (typeof value === "string") return { doneFrontierSeq: value };
  return { doneFrontierSeq: null };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function channelType(value: unknown, fallback: ActivityChannelType): ActivityChannelType {
  return typeof value === "string" && CHANNEL_TYPES.has(value as ActivityChannelType)
    ? value as ActivityChannelType
    : fallback;
}

function senderType(value: unknown): ActivitySenderType {
  return typeof value === "string" && SENDER_TYPES.has(value as ActivitySenderType)
    ? value as ActivitySenderType
    : "user";
}
