import { mergeMessages, type RaftMessage } from "./messages";

export function hasSeqGap(lastSeq: number, incomingSeq: number | undefined): boolean {
  if (incomingSeq === undefined || lastSeq <= 0) return false;
  return incomingSeq > lastSeq + 1;
}

/** Replace an optimistic row that shares randomId, otherwise append. */
export function reconcileIncoming(existing: RaftMessage[], incoming: RaftMessage): RaftMessage[] {
  if (!incoming.randomId) return mergeMessages(existing, [incoming]);
  const withoutOptimistic = existing.filter((message) => !(
    message.randomId === incoming.randomId && message.id.startsWith("optimistic-")
  ));
  return mergeMessages(withoutOptimistic, [incoming]);
}
