export interface RaftUser {
  id: string;
  email?: string | null;
  name?: string | null;
  displayName?: string | null;
  displayLanguage?: string | null;
  preferredMessageBodyFontSize?: string | null;
  preferredTimeFormat?: string | null;
  preferredTimezone?: string | null;
}

export interface MessageMention {
  type?: string;
  id?: string;
  name?: string;
}

export interface MessageAttachment {
  id?: string;
  filename: string;
  thumbnailUrl?: string | null;
  /** Server-rendered raster stand-in for formats the client cannot draw (SVG). */
  rasterPreviewUrl?: string | null;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds?: string[];
  reactedByMe?: boolean;
}

export interface RaftMessage {
  id: string;
  seq?: number;
  channelId: string;
  randomId?: string | null;
  senderType?: string;
  senderId?: string;
  senderName?: string;
  senderDisplayName?: string;
  senderAvatarUrl?: string | null;
  senderDescription?: string | null;
  messageType?: string;
  content: string;
  mentions?: MessageMention[];
  threadId?: string | null;
  createdAt?: string;
  attachments?: MessageAttachment[];
  reactions?: MessageReaction[];
  pending?: "sending" | "failed";
}

export interface ThreadReplyPreview {
  messageId: string;
  preview: string;
  senderName: string;
  senderDisplayName?: string;
  senderAvatarUrl?: string | null;
  senderType?: string;
  createdAt?: string;
}

export interface ThreadSummary {
  threadChannelId: string;
  replyCount: number;
  unreadCount?: number;
  lastReplyAt?: string | null;
  latestReplies?: ThreadReplyPreview[];
}

export interface ChannelReadState {
  kind?: string;
  maxReadSeq?: string;
  latestActivity?: { messageId?: string; seq?: string } | null;
}

export interface RaftChannel {
  id: string;
  name: string;
  description?: string | null;
  type?: string;
  archivedAt?: string | null;
  peerDisplayName?: string | null;
  peerName?: string | null;
  peerAvatarUrl?: string | null;
  peerType?: string | null;
  lastMessageAt?: string | null;
  joined?: boolean;
  activityMuted?: boolean;
  readState?: ChannelReadState | null;
  threadId?: string | null;
}

export interface ChannelUnreadEntry {
  unreadCount: number;
  hasMention: boolean;
}

export interface RaftServer {
  id: string;
  name: string;
  slug: string;
  avatarUrl?: string | null;
  role?: string | null;
}

export interface ServerUnread {
  serverId: string;
  unreadCount: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseUser(value: unknown): RaftUser | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    email: typeof value.email === "string" ? value.email : null,
    name: typeof value.name === "string" ? value.name : null,
    displayName: typeof value.displayName === "string" ? value.displayName : null,
    displayLanguage: typeof value.displayLanguage === "string" ? value.displayLanguage : null,
    preferredMessageBodyFontSize: typeof value.preferredMessageBodyFontSize === "string" ? value.preferredMessageBodyFontSize : null,
    preferredTimeFormat: typeof value.preferredTimeFormat === "string" ? value.preferredTimeFormat : null,
    preferredTimezone: typeof value.preferredTimezone === "string" ? value.preferredTimezone : null,
  };
}

export function userLabel(user: RaftUser | null): string {
  if (!user) return "";
  return user.displayName || user.name || user.email || "";
}

/** Server timestamps can be `YYYY-MM-DD HH:mm:ss.ffffff-07`. Hermes rejects that shape. */
export function parseCreatedAt(value: string): string {
  const normalized = value.trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, "$1T$2")
    .replace(/\.(\d{3})\d+/, ".$1")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
    .replace(/([+-]\d{2})$/, "$1:00");
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

export function parseMessage(value: unknown): RaftMessage | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.channelId !== "string") return null;
  return {
    id: value.id,
    seq: typeof value.seq === "number" ? value.seq : undefined,
    channelId: value.channelId,
    senderType: typeof value.senderType === "string" ? value.senderType : undefined,
    senderId: typeof value.senderId === "string" ? value.senderId : undefined,
    senderName: typeof value.senderName === "string" ? value.senderName : undefined,
    senderDisplayName: typeof value.senderDisplayName === "string" ? value.senderDisplayName : undefined,
    messageType: typeof value.messageType === "string" ? value.messageType : undefined,
    randomId: typeof value.randomId === "string" ? value.randomId : null,
    senderAvatarUrl: typeof value.senderAvatarUrl === "string" ? value.senderAvatarUrl : null,
    senderDescription: typeof value.senderDescription === "string" ? value.senderDescription : null,
    content: typeof value.content === "string" ? value.content : "",
    attachments: parseAttachments(value.attachments),
    reactions: parseReactions(value.reactions),
    mentions: Array.isArray(value.mentions) ? value.mentions.filter(isRecord).map((mention) => ({
      type: typeof mention.type === "string" ? mention.type : undefined,
      id: typeof mention.id === "string" ? mention.id : undefined,
      name: typeof mention.name === "string" ? mention.name : undefined,
    })) : undefined,
    threadId: typeof value.threadId === "string" ? value.threadId : value.threadId === null ? null : undefined,
    createdAt: typeof value.createdAt === "string" ? parseCreatedAt(value.createdAt) : undefined,
  };
}

export function parseMessagePage(data: unknown): RaftMessage[] {
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.messages)
      ? data.messages
      : [];
  return raw.map(parseMessage).filter((message): message is RaftMessage => message !== null);
}

export function historyLimited(data: unknown): boolean {
  return isRecord(data) && data.historyLimited === true;
}

export function parseThreadSummaries(data: unknown): Record<string, ThreadSummary> {
  if (!isRecord(data) || !isRecord(data.threadSummariesByParentMessageId)) return {};
  const summaries: Record<string, ThreadSummary> = {};
  for (const [parentId, value] of Object.entries(data.threadSummariesByParentMessageId)) {
    if (!isRecord(value) || typeof value.threadChannelId !== "string") continue;
    const replyCount = Number(value.replyCount);
    const unreadCount = Number(value.unreadCount);
    summaries[parentId] = {
      threadChannelId: value.threadChannelId,
      replyCount: Number.isFinite(replyCount) ? replyCount : 0,
      unreadCount: Number.isFinite(unreadCount) ? Math.max(0, Math.floor(unreadCount)) : 0,
      lastReplyAt: typeof value.lastReplyAt === "string" ? value.lastReplyAt : null,
      latestReplies: parseLatestReplies(value.latestReplies),
    };
  }
  return summaries;
}

export function parseChannelUnread(data: unknown): Record<string, ChannelUnreadEntry> {
  const rows = isRecord(data) && isRecord(data.channels) ? data.channels : null;
  const unread: Record<string, ChannelUnreadEntry> = {};
  if (!rows) return unread;
  for (const [channelId, value] of Object.entries(rows)) {
    if (!isRecord(value)) continue;
    const unreadCount = Number(value.unreadCount);
    if (!Number.isFinite(unreadCount)) continue;
    unread[channelId] = {
      unreadCount: Math.max(0, Math.floor(unreadCount)),
      hasMention: value.hasMention === true,
    };
  }
  return unread;
}

function parseLatestReplies(value: unknown): ThreadReplyPreview[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const replies = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.preview !== "string") return [];
    const senderName = typeof item.senderName === "string" ? item.senderName : "";
    return [{
      messageId: typeof item.messageId === "string" ? item.messageId : senderName + item.preview,
      preview: item.preview,
      senderName,
      senderDisplayName: typeof item.senderDisplayName === "string" ? item.senderDisplayName : undefined,
      senderAvatarUrl: typeof item.senderAvatarUrl === "string" ? item.senderAvatarUrl : null,
      senderType: typeof item.senderType === "string" ? item.senderType : undefined,
      createdAt: typeof item.createdAt === "string" ? parseCreatedAt(item.createdAt) : undefined,
    }];
  }).filter((reply) => reply.senderType !== "system").slice(0, 3);
  return replies.length > 0 ? replies : undefined;
}

function parseAttachments(value: unknown): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.filename !== "string") return [];
    const sizeBytes = Number(item.sizeBytes);
    return [{
      id: typeof item.id === "string" ? item.id : undefined,
      filename: item.filename,
      thumbnailUrl: typeof item.thumbnailUrl === "string" ? item.thumbnailUrl : null,
      width: typeof item.width === "number" && item.width > 0 ? item.width : undefined,
      height: typeof item.height === "number" && item.height > 0 ? item.height : undefined,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
}

function parseReactions(value: unknown): MessageReaction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reactions = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.emoji !== "string") return [];
    const userIds = Array.isArray(item.userIds) ? item.userIds.filter((id): id is string => typeof id === "string") : undefined;
    const count = typeof item.count === "number" ? item.count : userIds?.length ?? 1;
    return [{ emoji: item.emoji, count, userIds, reactedByMe: item.reactedByMe === true }];
  });
  return reactions.length > 0 ? reactions : undefined;
}

export function parseChannel(value: unknown): RaftChannel | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  const readState = isRecord(value.readState) ? {
    kind: typeof value.readState.kind === "string" ? value.readState.kind : undefined,
    maxReadSeq: typeof value.readState.maxReadSeq === "string" ? value.readState.maxReadSeq : undefined,
    latestActivity: isRecord(value.readState.latestActivity) ? {
      messageId: typeof value.readState.latestActivity.messageId === "string" ? value.readState.latestActivity.messageId : undefined,
      seq: typeof value.readState.latestActivity.seq === "string" ? value.readState.latestActivity.seq : undefined,
    } : null,
  } : null;
  return {
    id: value.id,
    name: value.name,
    description: typeof value.description === "string" ? value.description : null,
    type: typeof value.type === "string" ? value.type : "channel",
    archivedAt: typeof value.archivedAt === "string" ? value.archivedAt : null,
    peerDisplayName: typeof value.peerDisplayName === "string" ? value.peerDisplayName : null,
    peerName: typeof value.peerName === "string" ? value.peerName : null,
    peerAvatarUrl: typeof value.peerAvatarUrl === "string" ? value.peerAvatarUrl : null,
    peerType: typeof value.peerType === "string" ? value.peerType : null,
    lastMessageAt: typeof value.lastMessageAt === "string" ? value.lastMessageAt : null,
    joined: typeof value.joined === "boolean" ? value.joined : undefined,
    activityMuted: value.activityMuted === true,
    readState,
  };
}

export function parseChannels(data: unknown): RaftChannel[] {
  if (!Array.isArray(data)) return [];
  return data.map(parseChannel).filter((channel): channel is RaftChannel => channel !== null);
}

export function parseServers(data: unknown): RaftServer[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.slug !== "string") {
      return [];
    }
    return [{
      id: item.id,
      name: item.name,
      slug: item.slug,
      avatarUrl: typeof item.avatarUrl === "string" ? item.avatarUrl : null,
      role: typeof item.role === "string" ? item.role : null,
    }];
  });
}

export function parseUnreadSummary(data: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!Array.isArray(data)) return counts;
  for (const row of data) {
    if (!isRecord(row) || typeof row.serverId !== "string") continue;
    const unreadCount = Number(row.unreadCount);
    if (!Number.isFinite(unreadCount)) continue;
    counts[row.serverId] = Math.max(0, Math.floor(unreadCount));
  }
  return counts;
}

export function senderLabel(message: RaftMessage): string {
  return message.senderDisplayName || message.senderName || (message.senderType === "agent" ? "Agent" : "Member");
}

export function channelLabel(channel: RaftChannel): string {
  if (channel.type === "dm") return channel.peerDisplayName || channel.peerName || channel.name;
  return channel.name;
}

export function maxSeq(messages: RaftMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
}

export function minSeq(messages: RaftMessage[]): number | null {
  const seqs = messages.map((message) => message.seq).filter((seq): seq is number => typeof seq === "number");
  if (seqs.length === 0) return null;
  return Math.min(...seqs);
}

export function mergeMessages(existing: RaftMessage[], incoming: RaftMessage[]): RaftMessage[] {
  const byId = new Map<string, RaftMessage>();
  for (const message of [...existing, ...incoming]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => {
    const aSeq = typeof a.seq === "number" ? a.seq : Number.POSITIVE_INFINITY;
    const bSeq = typeof b.seq === "number" ? b.seq : Number.POSITIVE_INFINITY;
    return aSeq - bSeq || a.id.localeCompare(b.id);
  });
}
