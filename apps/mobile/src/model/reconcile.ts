import { mergeMessages, type RaftMessage } from "./messages";

/**
 * Seq is shared by the whole server, so a jump inside one channel is normal.
 * Live `message:new` must not call `/messages/sync`.
 */
export function liveMessageNeedsSync(
  _channelMaxSeq: number,
  _incomingSeq: number | undefined,
): boolean {
  return false;
}

/** Replace an optimistic row that shares randomId, otherwise append. */
export function reconcileIncoming(existing: RaftMessage[], incoming: RaftMessage): RaftMessage[] {
  if (!incoming.randomId) return mergeMessages(existing, [incoming]);
  const withoutOptimistic = existing.filter((message) => !(
    message.randomId === incoming.randomId && message.id.startsWith("optimistic-")
  ));
  return mergeMessages(withoutOptimistic, [incoming]);
}
