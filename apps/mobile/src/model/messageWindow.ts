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

/** Hide messages past the loaded slice so a live tail cannot pull an older window. */
export function visibleInWindow(messages: readonly RaftMessage[], hasNewer: boolean, ceilingSeq: number | null): RaftMessage[] {
  if (!hasNewer || ceilingSeq === null) return messages as RaftMessage[];
  return messages.filter((message) => typeof message.seq === "number" && message.seq <= ceilingSeq);
}
