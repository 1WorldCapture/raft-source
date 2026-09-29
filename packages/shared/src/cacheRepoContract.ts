// Cache repository contract (desktop-data-cache task #6 / P0).
//
// The storage-facing interface shared by the mobile SQLite repository
// (apps/mobile/src/cache/repo.ts) and the upcoming Web IndexedDB repository
// (task #7). Pure types + method signatures only — NO storage code lives
// here. The sync scheduler (cacheSync) and seeding helpers (cacheBoot) in
// this package program against this interface, so every implementation gets
// the same merge/gate semantics for free.
//
// Semantics that implementations MUST preserve (enforced by the shared
// unit tests running against every repo):
//   - scopes: (origin, userId, serverId) partitions; wipeScope/wipeAll clear
//     data AND coverage; openScope is idempotent per identity.
//   - coverage ranges grow only from appendPage (server-contiguous pages)
//     or an appendLiveMessage that directly follows the tail while
//     connected (see cacheMerge.ts for the invariant).
//   - applyOverlayPage/applyMessageUpdated write dynamic data overlays with
//     a last-write-wins on server updatedAt; overlay_pages bookkeeping is
//     stamped with the repo's bootId and ONLY applyOverlayPage writes it.
//   - applyReadState/applyTaskEvent are version/revision gated — a stale
//     event must not regress stored state.

import type { MessageWindowCoverage, Range } from "./cacheMerge.ts";

export type RawRecord = Record<string, unknown>;

export type PutChannelRow = {
  id: string;
  type: string;
  lastMessageAt?: string | null;
  raw: RawRecord;
};

export type AppendPage = {
  messages: Array<{ seq: number; id: string; raw: RawRecord }>;
  window?: MessageWindowCoverage;
};

export type OverlayPage = {
  fromSeq: number;
  throughSeq: number;
  messages: Array<{ seq: number; id?: string; raw: RawRecord; updatedAt?: string | null }>;
  threadSummaries?: Record<string, RawRecord & { threadChannelId?: string }>;
};

export type ThreadSummaryInput = {
  parentChannelId: string;
  parentMessageId: string;
  raw: RawRecord & { threadChannelId?: string };
};

export type TaskEventInput = {
  id: string;
  revision: number;
  raw: RawRecord;
};

export type CachedMessage = {
  seq: number;
  id: string;
  raw: RawRecord;
  overlay: RawRecord | null;
};

export type CachedChannel = {
  id: string;
  type: string;
  lastMessageAt: string | null;
  raw: RawRecord;
};

export type OverlayPageInfo = {
  throughSeq: number;
  refreshedAt: string;
  bootId: string;
};

export type ReadStateRow = { maxReadSeq: number; version: number };

export type CachedTaskRow = { id: string; revision: number; raw: RawRecord };

/**
 * The storage contract. Method-for-method the public surface of the mobile
 * repo; an IndexedDB implementation must satisfy this shape. Reads may be
 * synchronous on mobile (node:sqlite/expo sync APIs) — Web implementations
 * should wrap IndexedDB in a small promise-caching layer to honor the sync
 * signatures, or we loosen these to Promise<T> in a follow-up once measured
 * (the sync reads power the cold-start first paint; keeping them sync in the
 * contract means the seed path cannot accidentally await).
 */
export interface CacheRepo {
  /** Per-repo-instance boot identity; overlay once-per-boot gates key on it. */
  readonly bootId: string;

  // ---- scopes / lifecycle --------------------------------------------------

  /** Idempotent per (origin, userId, serverId); returns the scopeId. */
  openScope(origin: string, userId: string, serverId: string): number;
  /** Clear one scope's data, coverage and bookkeeping. */
  wipeScope(scopeId: number): Promise<void>;
  /** Clear EVERYTHING (logout / origin change). */
  wipeAll(): Promise<void>;

  // ---- channels ------------------------------------------------------------

  getChannels(scopeId: number, types?: readonly string[]): CachedChannel[];
  putChannels(scopeId: number, rows: readonly PutChannelRow[]): Promise<void>;
  /** Cascade: channel + its messages + coverage + overlays + read state. */
  deleteChannel(scopeId: number, channelId: string): Promise<void>;

  // ---- messages + coverage ---------------------------------------------------

  getCoverage(scopeId: number, channelId: string): Range[];
  /** Newest-first. */
  getLatestMessages(scopeId: number, channelId: string, limit: number): CachedMessage[];
  /** The ONLY writer allowed to create/extend ranges (plus a qualifying live tail). */
  appendPage(scopeId: number, channelId: string, page: AppendPage): Promise<void>;
  /** Always stores; extends the tail range only when directly following AND connected. */
  appendLiveMessage(
    scopeId: number,
    channelId: string,
    message: { seq: number; id: string; raw: RawRecord },
    opts: { connected: boolean },
  ): Promise<void>;
  /** Cut messages older than the cutoff and rebuild coverage from survivors. */
  pruneMessages(scopeId: number, olderThanIso: string): Promise<void>;

  // ---- dynamic-data overlays --------------------------------------------------

  /** A re-fetched page overwrites the dynamic data of its span. */
  applyOverlayPage(scopeId: number, channelId: string, page: OverlayPage): Promise<void>;
  getOverlayPageInfo(scopeId: number, channelId: string, fromSeq: number): OverlayPageInfo | null;
  /** Drop the once-per-boot refresh markers (data kept) — reconnect retry. */
  invalidateOverlayPageMarks(scopeId: number): Promise<void>;
  /** message:updated write-through (reactions and other projections). */
  applyMessageUpdated(
    scopeId: number,
    channelId: string,
    message: { seq: number; raw: RawRecord; updatedAt?: string | null },
  ): Promise<void>;

  // ---- thread summaries ---------------------------------------------------

  applyThreadSummary(scopeId: number, summary: ThreadSummaryInput): Promise<void>;
  getThreadSummaries(scopeId: number, parentChannelId: string): Record<string, RawRecord>;

  // ---- tasks ----------------------------------------------------------------

  /** Revision-gated: a stale event must not regress the stored row. */
  applyTaskEvent(scopeId: number, task: TaskEventInput): Promise<void>;
  deleteTask(scopeId: number, taskId: string): Promise<void>;
  getTaskRows(scopeId: number): CachedTaskRow[];

  // ---- read state -------------------------------------------------------------

  /** Version-gated upsert. */
  applyReadState(scopeId: number, channelId: string, maxReadSeq: number, version: number): Promise<void>;
  getReadStates(scopeId: number): Record<string, ReadStateRow>;

  // ---- inbox pages (activity cache pane) --------------------------------------

  getInboxPage(scopeId: number, pageNo: number): RawRecord | null;
  putInboxPage(scopeId: number, pageNo: number, raw: RawRecord): Promise<void>;

  // ---- misc kv ------------------------------------------------------------------

  getKv(scopeId: number, key: string): RawRecord | null;
  putKv(scopeId: number, key: string, value: RawRecord): Promise<void>;
}
