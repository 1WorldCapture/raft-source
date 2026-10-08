import { maxSeq, mergeMessages, parseMessagePage, isRecord, type RaftMessage } from "./messages";

/** Inverted FlatList: viewPosition 0 is the visual bottom, so the upper third is 2/3. */
export const JUMP_VIEW_POSITION = 2 / 3;

export interface MessageContextPage {
  targetMessageId: string | null;
  messages: RaftMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface MessageWindow {
  messages: RaftMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  ceilingSeq: number;
}

export function parseMessageContext(data: unknown): MessageContextPage | null {
  if (!isRecord(data)) return null;
  return {
    targetMessageId: typeof data.targetMessageId === "string" ? data.targetMessageId : null,
    messages: parseMessagePage(data),
    hasOlder: data.hasOlder === true,
    hasNewer: data.hasNewer === true,
  };
}

export function shouldRequestContext(messages: readonly { id: string }[], targetMessageId: string | null | undefined): boolean {
  if (!targetMessageId) return false;
  return !messages.some((message) => message.id === targetMessageId);
}

/** Replace the open slice with the context page. Keep only rows that sit inside that slice. */
export function applyContextWindow(existing: readonly RaftMessage[], page: MessageContextPage): MessageWindow {
  const context = mergeMessages([], page.messages);
  const seqs = context.flatMap((message) => typeof message.seq === "number" ? [message.seq] : []);
  const oldest = seqs.length > 0 ? Math.min(...seqs) : null;
  const newest = seqs.length > 0 ? Math.max(...seqs) : 0;
  const inside = oldest === null ? [] : existing.filter((message) => (
    typeof message.seq === "number" && message.seq >= oldest && message.seq <= newest
  ));
  const messages = mergeMessages(inside, context);
  return {
    messages,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
    ceilingSeq: maxSeq(messages),
  };
}

/** Append a newer page. A short page means this slice now reaches the latest message. */
export function appendNewerPage(existing: readonly RaftMessage[], incoming: readonly RaftMessage[], limit: number): {
  messages: RaftMessage[];
  hasNewer: boolean;
  ceilingSeq: number;
} {
  const messages = mergeMessages([...existing], [...incoming]);
  return {
    messages,
    hasNewer: incoming.length >= limit,
    ceilingSeq: maxSeq(messages),
  };
}

export interface RememberedWindow {
  ceilingSeq: number;
  hasOlder: boolean;
}

const rememberedWindows = new Map<string, RememberedWindow>();

function windowKey(channelId: string, targetMessageId: string): string {
  return `${channelId}\0${targetMessageId}`;
}

/** Keep a context slice across a remount. A fresh mount otherwise treats a cached target as the latest page. */
export function rememberContextWindow(channelId: string, targetMessageId: string, window: RememberedWindow): void {
  rememberedWindows.set(windowKey(channelId, targetMessageId), window);
}

export function recallContextWindow(
  channelId: string,
  targetMessageId: string,
  messages: readonly { seq?: number }[],
): RememberedWindow | null {
  const saved = rememberedWindows.get(windowKey(channelId, targetMessageId));
  if (!saved) return null;
  if (!messages.some((message) => message.seq === saved.ceilingSeq)) return null;
  return saved;
}

export function advanceContextWindow(channelId: string, targetMessageId: string, ceilingSeq: number): void {
  const saved = rememberedWindows.get(windowKey(channelId, targetMessageId));
  if (!saved) return;
  rememberedWindows.set(windowKey(channelId, targetMessageId), { ...saved, ceilingSeq });
}

export function forgetContextWindow(channelId: string): void {
  for (const key of rememberedWindows.keys()) {
    if (key.startsWith(`${channelId}\0`)) rememberedWindows.delete(key);
  }
}

/** Hide messages past the loaded slice so a live tail cannot pull an older window. */
export function visibleInWindow(messages: readonly RaftMessage[], hasNewer: boolean, ceilingSeq: number | null): RaftMessage[] {
  if (!hasNewer || ceilingSeq === null) return messages as RaftMessage[];
  return messages.filter((message) => typeof message.seq === "number" && message.seq <= ceilingSeq);
}

/** Persisted rows kept while the reader is on the latest message. */
export const TAIL_LIMIT = 50;

/** Persisted rows kept while the reader is scrolled into older history. */
export const HISTORY_LIMIT = 200;

/**
 * Inverted FlatList: content offset 0 is the latest row. Follow only while
 * that edge is on screen and the in-memory bucket still contains the real tail.
 */
export const TAIL_FOLLOW_OFFSET = 100;

export function shouldFollowTail(offsetY: number, tailInMemory: boolean): boolean {
  return tailInMemory && offsetY < TAIL_FOLLOW_OFFSET;
}

function splitBySeq<T extends { id: string; seq?: number }>(messages: readonly T[]): { persisted: T[]; pending: T[] } {
  const pending: T[] = [];
  const persisted: T[] = [];
  for (const message of messages) {
    if (typeof message.seq === "number") persisted.push(message);
    else pending.push(message);
  }
  persisted.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id));
  return { persisted, pending };
}

/** Newest persisted rows, plus any optimistic row that has no seq yet. */
export function retainNewest<T extends { id: string; seq?: number }>(messages: readonly T[], limit: number): T[] {
  const { persisted, pending } = splitBySeq(messages);
  if (persisted.length <= limit) return messages as T[];
  return [...persisted.slice(persisted.length - limit), ...pending];
}

/** Oldest persisted rows, so a reader who scrolled up keeps the page they are on. */
export function retainOldest<T extends { id: string; seq?: number }>(messages: readonly T[], limit: number): T[] {
  const { persisted, pending } = splitBySeq(messages);
  if (persisted.length <= limit) return messages as T[];
  return [...persisted.slice(0, limit), ...pending];
}

/**
 * Tail mode keeps the latest page and drops older rows.
 * History mode keeps the page being read and, once the cap is hit, drops the far tail.
 */
export function applyMemoryCap<T extends { id: string; seq?: number }>(
  messages: readonly T[],
  follow: boolean,
): { messages: T[]; droppedOlder: boolean; droppedTail: boolean } {
  if (follow) {
    const next = retainNewest(messages, TAIL_LIMIT);
    return { messages: next, droppedOlder: next.length !== messages.length, droppedTail: false };
  }
  const next = retainOldest(messages, HISTORY_LIMIT);
  return { messages: next, droppedOlder: false, droppedTail: next.length !== messages.length };
}
