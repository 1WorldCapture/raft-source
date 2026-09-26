import type { ChannelReadState } from "./messages";

function compareDecimal(left: string, right: string): number {
  const a = left.replace(/^0+/, "") || "0";
  const b = right.replace(/^0+/, "") || "0";
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export interface ChannelUnread {
  unread: boolean;
  count: number | null;
}

/**
 * Channel rows carry an inbox read frontier. `absent` means no cursor and
 * stays unread. A missing frontier is not treated as unread, because that
 * would badge every row when the payload omits read state. A present cursor
 * is unread when the latest activity seq is ahead of maxReadSeq. The numeric
 * badge is only shown when the gap fits in a safe integer.
 */
export function channelUnread(readState: ChannelReadState | null | undefined): ChannelUnread {
  if (!readState) return { unread: false, count: null };
  if (readState.kind === "absent") return { unread: true, count: null };
  if (readState.kind === "corrupt") return { unread: false, count: null };
  if (readState.kind !== "present") return { unread: false, count: null };

  const latest = readState.latestActivity?.seq;
  const read = readState.maxReadSeq;
  if (!latest || read === undefined) return { unread: false, count: null };
  const order = compareDecimal(latest, read);
  if (order <= 0) return { unread: false, count: 0 };

  const latestNumber = Number(latest);
  const readNumber = Number(read);
  if (
    Number.isSafeInteger(latestNumber) &&
    Number.isSafeInteger(readNumber) &&
    latestNumber - readNumber > 0 &&
    latestNumber - readNumber < 1000
  ) {
    return { unread: true, count: latestNumber - readNumber };
  }
  return { unread: true, count: null };
}
