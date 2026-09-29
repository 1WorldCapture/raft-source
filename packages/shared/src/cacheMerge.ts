// Pure merge rules for the local cache (client-data-cache task #1).
//
// Everything here is side-effect free and unit-tested; the repository layer
// applies these to rows. The central invariant is the "coverage range" model:
//
//   A range [fromSeq, throughSeq] claims: every receiver-visible message in
//   this seq span is cached. Ranges only ever grow from SERVER PAGE results
//   (fetch pages / sync batches), which are visibility-filtered and ordered.
//   A single realtime message can extend the tail range ONLY when it directly
//   follows it AND the socket was connected the whole time — otherwise the
//   message is stored but the range stays put, so a later sync of the gap
//   cannot be skipped (Firstmate review note #1).

export type Range = { fromSeq: number; throughSeq: number };

/** Server-side coverage metadata returned with message pages. */
export type MessageWindowCoverage = {
  coveredFromSeq: number;
  coveredThroughSeq: number;
  hasGap: boolean;
};

/** Insert `incoming` into a sorted, non-overlapping range list, fusing. */
export function mergeRanges(existing: readonly Range[], incoming: Range): Range[] {
  if (incoming.fromSeq > incoming.throughSeq) return existing.map((r) => ({ ...r }));
  const all = [...existing, incoming].sort(
    (a, b) => a.fromSeq - b.fromSeq || a.throughSeq - b.throughSeq,
  );
  const out: Range[] = [];
  for (const range of all) {
    const last = out[out.length - 1];
    if (last && range.fromSeq <= last.throughSeq + 1) {
      last.throughSeq = Math.max(last.throughSeq, range.throughSeq);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/**
 * The coverage range a fetched page proves. Rules (approved draft):
 *   - window without gaps → the server's covered span (may include messages
 *     the 50-row window filtered out, e.g. deeper history);
 *   - window with gaps, or no window → the span of the returned rows only.
 */
export function pageRange(
  rows: readonly { seq: number }[],
  window?: MessageWindowCoverage,
): Range | null {
  if (window && !window.hasGap) {
    return { fromSeq: window.coveredFromSeq, throughSeq: window.coveredThroughSeq };
  }
  if (rows.length === 0) return null;
  let from = rows[0].seq;
  let through = rows[0].seq;
  for (const row of rows) {
    if (row.seq < from) from = row.seq;
    if (row.seq > through) through = row.seq;
  }
  return { fromSeq: from, throughSeq: through };
}

/**
 * May a single realtime message extend the tail coverage? Only when the
 * socket stayed connected and the message directly follows the tail range.
 * Inside-range messages need no extension; no ranges → no extension (the
 * base coverage must come from a page/sync first).
 */
export function canExtendTailWithLive(ranges: readonly Range[], seq: number, connected: boolean): boolean {
  if (!connected) return false;
  return ranges.some((range) => range.throughSeq + 1 === seq);
}

/** Contiguous runs of a sorted seq list — rebuilds true coverage after prune. */
export function contiguousRuns(sortedSeqs: readonly number[]): Range[] {
  const runs: Range[] = [];
  for (const seq of sortedSeqs) {
    const last = runs[runs.length - 1];
    if (last && last.throughSeq + 1 === seq) last.throughSeq = seq;
    else runs.push({ fromSeq: seq, throughSeq: seq });
  }
  return runs;
}

/** Last-write-wins guard for per-message overlays (stale pages must not win). */
export function overlayIsNewer(storedUpdatedAt: string | null, incomingUpdatedAt: string): boolean {
  if (storedUpdatedAt === null) return true;
  return incomingUpdatedAt > storedUpdatedAt;
}

/** Task rows only move forward: drop events at or below the stored revision. */
export function taskRevisionGate(storedRevision: number | null, incomingRevision: number): boolean {
  if (storedRevision === null) return true;
  return incomingRevision > storedRevision;
}

export type OverlayPageRow = { refreshedAt: string; bootId: string };

/**
 * Once per boot per page: a page refresh already recorded for this boot is
 * not refreshed again until the next app launch (task #3's lazy overlay rule).
 */
export function overlayPageNeedsRefresh(row: OverlayPageRow | null, bootId: string): boolean {
  if (row === null) return true;
  return row.bootId !== bootId;
}
