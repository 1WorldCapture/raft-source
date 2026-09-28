// Boot fast-path helpers (client-data-cache task #2). Pure functions that
// turn cache rows into seedable store payloads and pick the network fetch
// plan from local coverage. Wiring lives in the screens/stores; these stay
// trivially unit-testable.

import { parseMessage, type RaftChannel, type RaftMessage } from "../model/messages";
import type { Range } from "./merge";
import type { CachedMessage } from "./repo";

/** Cached channel rows are stored as parsed channels; pass them through. */
export function seedConversations(rows: Array<{ id: string; type: string; raw: unknown }>): RaftChannel[] {
  return rows.flatMap((row) => {
    const channel = row.raw as RaftChannel | null;
    return channel && typeof channel === "object" && typeof channel.id === "string" ? [channel] : [];
  });
}

/** The highest covered seq, i.e. what an `after=` fetch would continue from. */
export function latestCoverageThrough(coverage: readonly Range[]): number | null {
  let best: number | null = null;
  for (const range of coverage) {
    if (best === null || range.throughSeq > best) best = range.throughSeq;
  }
  return best;
}

/**
 * Fetch plan for opening a channel: with local coverage continue from the
 * tail (`after=through`), otherwise request the latest page.
 */
export function messageFetchPlan(
  coverage: readonly Range[],
): { after: number } | { latest: true } {
  const through = latestCoverageThrough(coverage);
  return through === null ? { latest: true } : { after: through };
}

/** Overlay wins over the base body; invalid rows are dropped, never thrown. */
export function hydrateCachedMessages(rows: readonly CachedMessage[]): RaftMessage[] {
  const out: RaftMessage[] = [];
  for (const row of rows) {
    const merged = { ...row.raw, ...row.overlay } as Record<string, unknown>;
    const parsed = parseMessage(merged);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Drain an `after=` catch-up to the newest tail (review fix): a full page
 * means MORE newer messages exist beyond it, so keep paging until a short
 * page — otherwise a >PAGE gap offline shows stale content with hasNewer
 * false. `maxPages` caps pathological loops (default 40 pages ≈ 2000
 * messages).
 */
export async function drainAfterPages<T>(
  startAfter: number,
  fetchPage: (after: number) => Promise<readonly T[]>,
  isFull: (page: readonly T[]) => boolean,
  maxPages = 40,
): Promise<{ pages: T[][]; lastSeq: number }> {
  const pages: T[][] = [];
  let after = startAfter;
  let lastSeq = startAfter;
  for (let fetched = 0; fetched < maxPages; fetched += 1) {
    const page = await fetchPage(after);
    if (page.length === 0) break;
    pages.push([...page]);
    for (const item of page) {
      const seq = (item as { seq?: unknown }).seq;
      if (typeof seq === "number" && seq > lastSeq) lastSeq = seq;
    }
    if (!isFull(page)) break;
    after = lastSeq;
  }
  return { pages, lastSeq };
}

type RawPageLike = {
  messages?: unknown;
  messageWindow?: {
    coveredFromSeq?: unknown;
    coveredThroughSeq?: unknown;
    hasGap?: unknown;
  } | null;
};

/**
 * Extract a cache-appendable page from a raw `/messages/channel` response
 * WITHOUT disturbing the screen's own parsing. Window fields are coerced;
 * absent or malformed windows degrade to the row span (repo rule).
 */
export function rawPageForCache(
  data: unknown,
  toRow: (message: unknown) => { seq: number; id: string; raw: Record<string, unknown> } | null,
): { messages: Array<{ seq: number; id: string; raw: Record<string, unknown> }>; window?: { coveredFromSeq: number; coveredThroughSeq: number; hasGap: boolean } } {
  const source: RawPageLike =
    data && typeof data === "object" && !Array.isArray(data) ? (data as RawPageLike) : { messages: data };
  const list = Array.isArray(source.messages) ? source.messages : [];
  const messages = list.flatMap((item) => {
    const row = toRow(item);
    return row ? [row] : [];
  });
  const window =
    source.messageWindow &&
    typeof source.messageWindow.coveredFromSeq === "number" &&
    typeof source.messageWindow.coveredThroughSeq === "number"
      ? {
          coveredFromSeq: source.messageWindow.coveredFromSeq,
          coveredThroughSeq: source.messageWindow.coveredThroughSeq,
          hasGap: source.messageWindow.hasGap === true,
        }
      : undefined;
  return { messages, ...(window ? { window } : {}) };
}
