// Incremental sync + realtime write-through scheduler (client-data-cache
// task #3). Owns nothing persistent itself: all storage goes through the
// task #1 repository (repo.ts), all network goes through injected fetchers,
// so the whole module is unit-testable against a real node:sqlite repo with
// fake fetchers.
//
// Sync loop contract (Firstmate review, #client-data-cache:395285f7):
// - GET /messages/sync returns EVERY visible message with seq > sinceSeq in
//   ascending seq order (limit truncates the tail only). Because of that
//   ordering, a batch's per-channel [minSeq, maxSeq] is a valid coverage
//   range for that channel: every message of the channel inside that span
//   is either in the batch or was truncated — and truncation only cuts the
//   tail, which the next loop iteration re-pulls from the advanced cursor.
// - The cursor advances ONLY after every page of the loop succeeded. A mid-
//   loop failure leaves already-appended pages in place (upserts are
//   idempotent) and the cursor untouched, so the next sync re-pulls the
//   overlap instead of skipping the gap.
// - seq is a whole-table bigserial shared across servers; holes inside a
//   channel's range therefore mean nothing — coverage means "every message
//   of THIS channel within the range is stored locally".
//
// Interval-building rule (review note #1): a realtime message extends the
// tail coverage range only when it directly follows the tail AND the socket
// stayed connected; appendLiveMessage(connected) implements that, the
// caller passes the socket state (false until the post-reconnect sync has
// completed — see shouldExtendLiveTail below).

import type { CacheRepo, RawRecord, ThreadSummaryInput, TaskEventInput, AppendPage, OverlayPage } from "./repo";

export type SyncWireMessage = {
  seq: number;
  id: string;
  channelId: string;
  raw: RawRecord;
};

export type SyncOutcome = {
  pulled: number;
  cursor: number;
  /** True when a stillActive check aborted the loop before the cursor advanced. */
  aborted: boolean;
};

export type CacheSyncDeps = {
  repo: CacheRepo;
  /** GET /messages/sync — must return seq-ascending visible messages with seq > sinceSeq. */
  fetchSyncPage: (sinceSeq: number, limit: number) => Promise<readonly SyncWireMessage[]>;
  /**
   * Re-fetch one seq window of a channel for the overlay refresh
   * (GET /messages/channel/:id?after=<fromSeq-1>&limit=… translated by the
   * integration layer). Returns null when the server has nothing there.
   */
  fetchOverlayPage?: (channelId: string, fromSeq: number, throughSeq: number) => Promise<OverlayPage | null>;
};

export const SYNC_PAGE_LIMIT = 500;
const CURSOR_KEY = "syncCursor";

export function createCacheSync(deps: CacheSyncDeps) {
  const repo = deps.repo;

  function readCursor(scopeId: number): number {
    const kv = repo.getKv(scopeId, CURSOR_KEY);
    const maxSeq = kv && typeof kv.maxSeq === "number" ? kv.maxSeq : 0;
    return Number.isSafeInteger(maxSeq) && maxSeq > 0 ? maxSeq : 0;
  }

  async function writeCursor(scopeId: number, maxSeq: number): Promise<void> {
    await repo.putKv(scopeId, CURSOR_KEY, { maxSeq });
  }

  /**
   * Full gap sync for one scope: loop /messages/sync pages until a short
   * page, grouping each batch per channel into appendPage calls. Cursor
   * advancement happens once, after the loop completes without throwing.
   * A stillActive() that turns false aborts before the next batch write —
   * the cursor stays at its pre-run value.
   */
  async function syncAll(scopeId: number, opts?: { stillActive?: () => boolean }): Promise<SyncOutcome> {
    const initialCursor = readCursor(scopeId);
    let cursor = initialCursor;
    let pulled = 0;
    for (;;) {
      const batch = await deps.fetchSyncPage(cursor, SYNC_PAGE_LIMIT);
      if (batch.length === 0) break;
      if (opts?.stillActive && !opts.stillActive()) {
        return { pulled, cursor: initialCursor, aborted: true };
      }
      const byChannel = new Map<string, Array<{ seq: number; id: string; raw: RawRecord }>>();
      for (const message of batch) {
        const bucket = byChannel.get(message.channelId) ?? [];
        bucket.push({ seq: message.seq, id: message.id, raw: message.raw });
        byChannel.set(message.channelId, bucket);
      }
      for (const [channelId, messages] of byChannel) {
        // Ascending full-visible batch ⇒ the per-channel group is a valid
        // contiguous coverage window (see the header contract).
        const seqs = messages.map((m) => m.seq);
        await repo.appendPage(scopeId, channelId, {
          messages,
          window: {
            coveredFromSeq: Math.min(...seqs),
            coveredThroughSeq: Math.max(...seqs),
            hasGap: false,
          },
        });
      }
      pulled += batch.length;
      // Ascending order ⇒ the last element carries the batch max.
      const batchMax = batch[batch.length - 1]!.seq;
      if (batchMax > cursor) cursor = batchMax;
      if (batch.length < SYNC_PAGE_LIMIT) break;
    }
    await writeCursor(scopeId, cursor);
    return { pulled, cursor, aborted: false };
  }

  // ---- realtime write-through (thin schedulers over the repo) --------------

  /** message:new. `connected` must reflect socket continuity (see header). */
  function onLiveMessage(
    scopeId: number,
    channelId: string,
    message: { seq: number; id: string; raw: RawRecord },
    connected: boolean,
  ): Promise<void> {
    return repo.appendLiveMessage(scopeId, channelId, message, { connected });
  }

  /** message:updated — reactions and other projections land in the overlay layer. */
  function onMessageUpdated(
    scopeId: number,
    channelId: string,
    message: { seq: number; raw: RawRecord; updatedAt?: string | null },
  ): Promise<void> {
    return repo.applyMessageUpdated(scopeId, channelId, message);
  }

  /** thread:updated socket event. */
  function onThreadSummary(scopeId: number, summary: ThreadSummaryInput): Promise<void> {
    return repo.applyThreadSummary(scopeId, summary);
  }

  /** task:created / task:updated (revision-gated inside the repo). */
  function onTaskEvent(scopeId: number, task: TaskEventInput): Promise<void> {
    return repo.applyTaskEvent(scopeId, task);
  }

  /** task:deleted. */
  function onTaskDeleted(scopeId: number, taskId: string): Promise<void> {
    return repo.deleteTask(scopeId, taskId);
  }

  /** read_state socket event (version-gated inside the repo). */
  function onReadState(
    scopeId: number,
    channelId: string,
    maxReadSeq: number,
    version: number,
  ): Promise<void> {
    return repo.applyReadState(scopeId, channelId, maxReadSeq, version);
  }

  // ---- overlay once-per-boot refresh (task #3 ③) -----------------------------

  /**
   * Refresh a page's dynamic data at most once per boot: skip when the
   * overlay_pages row for (channelId, fromSeq) already carries this boot's
   * id (applyOverlayPage stamps it). Visible-area hooks and the latest-4-
   * pages opening refresh both funnel through here, so the gate needs no
   * extra bookkeeping of its own.
   */
  async function refreshOverlayPageOncePerBoot(
    scopeId: number,
    channelId: string,
    fromSeq: number,
    throughSeq: number,
  ): Promise<{ refreshed: boolean; reason: "already" | "no-fetcher" | "empty" | "done" }> {
    const info = repo.getOverlayPageInfo(scopeId, channelId, fromSeq);
    if (info && info.bootId === repo.bootId) return { refreshed: false, reason: "already" };
    if (!deps.fetchOverlayPage) return { refreshed: false, reason: "no-fetcher" };
    const page = await deps.fetchOverlayPage(channelId, fromSeq, throughSeq);
    if (!page) return { refreshed: false, reason: "empty" };
    await repo.applyOverlayPage(scopeId, channelId, page);
    return { refreshed: true, reason: "done" };
  }

  // ---- history pagination (task #3 ④) ---------------------------------------

  /** A before=<fromSeq> page fetched while scrolling up, stored with its window. */
  function appendHistoryPage(
    scopeId: number,
    channelId: string,
    page: AppendPage,
  ): Promise<void> {
    return repo.appendPage(scopeId, channelId, page);
  }

  return {
    readCursor,
    syncAll,
    onLiveMessage,
    onMessageUpdated,
    onThreadSummary,
    onTaskEvent,
    onTaskDeleted,
    onReadState,
    refreshOverlayPageOncePerBoot,
    appendHistoryPage,
  };
}

export type CacheSync = ReturnType<typeof createCacheSync>;

/**
 * Tail-extension gate for live messages. The socket layer knows continuity;
 * this helper expresses the review rule as data: extend only while connected
 * AND after the post-reconnect sync has finished (gap-free tail).
 */
export function shouldExtendLiveTail(connected: boolean, syncCompletedAfterConnect: boolean): boolean {
  return connected && syncCompletedAfterConnect;
}
