// Live-write marks (desktop-data-cache task #9): a per-process counter that
// stamps every realtime overlay write (message:updated), so a page response
// landing later can skip the rows that changed while its request was in
// flight — the server's updatedAt cannot order them (adding/removing a
// reaction does not touch messages.updated_at), and last-write-wins would
// let the older page response shadow the newer live value.
//
// Moved from packages/web/src/cache/messageCache.ts so web and mobile share
// one implementation; web re-exports it, behavior identical.
//
// In memory only: tabs/processes do not share marks, so a page in one tab
// can still overwrite a live write that only another tab saw (accepted for
// now).

let liveWriteCounter = 0;
const liveWriteMarks = new Map<string, number>();
const LIVE_WRITE_MARKS_MAX = 10_000;

function liveWriteKey(scopeId: number, channelId: string, seq: number): string {
  return `${scopeId}:${channelId}:${seq}`;
}

/** Stamp one realtime overlay write (message:updated) for scope/channel/seq. */
export function noteLiveWrite(scopeId: number, channelId: string, seq: number): void {
  liveWriteCounter += 1;
  const markKey = liveWriteKey(scopeId, channelId, seq);
  // Re-insert so the map stays in write order, then drop the oldest marks
  // once it grows: a mark only matters to requests already in flight.
  liveWriteMarks.delete(markKey);
  liveWriteMarks.set(markKey, liveWriteCounter);
  if (liveWriteMarks.size > LIVE_WRITE_MARKS_MAX) {
    for (const key of liveWriteMarks.keys()) {
      if (liveWriteMarks.size <= LIVE_WRITE_MARKS_MAX / 2) break;
      liveWriteMarks.delete(key);
    }
  }
}

/** Capture before a page request; pass to liveWriteAfter with the response. */
export function captureLiveWriteMark(): number {
  return liveWriteCounter;
}

/** True when this row got a live overlay write after `mark` was captured. */
export function liveWriteAfter(scopeId: number, channelId: string, seq: number, mark: number): boolean {
  return (liveWriteMarks.get(liveWriteKey(scopeId, channelId, seq)) ?? -1) > mark;
}
