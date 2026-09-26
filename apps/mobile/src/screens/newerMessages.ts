/** How many messages are newer than the previous high-water seq. Older history does not count. A zero baseline is the first page, not new messages. */
export function newerMessageCount(
  messages: readonly { seq?: number; senderId?: string }[],
  previousMaxSeq: number,
  viewerId?: string,
): { newest: number; added: number } {
  let newest = previousMaxSeq;
  let added = 0;
  for (const message of messages) {
    if (typeof message.seq !== "number") continue;
    if (previousMaxSeq > 0 && message.seq > previousMaxSeq && !(viewerId && message.senderId === viewerId)) added += 1;
    if (message.seq > newest) newest = message.seq;
  }
  return { newest, added: previousMaxSeq > 0 ? added : 0 };
}
