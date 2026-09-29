// In-memory CacheRepo implementation for the web message-cache bridge
// (desktop-data-cache task #9 / P2b).
//
// STOPGAP by design: task #7 (DevShrimp) lands the IndexedDB repository
// against the same shared contract; this module exists so the store wiring,
// coverage accounting and fetch plans can be built and unit-tested now,
// against the async contract, without waiting for storage. Swap points are
// typed against `CacheRepo` only — nothing else in packages/web knows how
// the bytes are stored.
//
// Semantics deliberately mirror the mobile SQLite repo (apps/mobile repo.ts):
//   - coverage ranges grow only from appendPage (server-contiguous pages) or
//     an appendLiveMessage that directly follows the tail while connected;
//   - overlay writes are gated by overlayIsNewer (server updatedAt wins);
//   - read states / task rows are version/revision gated;
//   - overlay_pages bookkeeping is stamped with the repo's bootId and only
//     applyOverlayPage writes it (once-per-boot refresh gate).
// All merge math comes from @botiverse/raft-shared — no local reimplementing.

import {
  canExtendTailWithLive,
  mergeRanges,
  overlayIsNewer,
  pageRange,
  taskRevisionGate,
} from "@botiverse/raft-shared/src/cacheMerge.js";
import type {
  AppendPage,
  CacheRepo,
  CachedChannel,
  CachedMessage,
  CachedTaskRow,
  OverlayPage,
  OverlayPageInfo,
  PutChannelRow,
  RawRecord,
  ReadStateRow,
  TaskEventInput,
  ThreadSummaryInput,
} from "@botiverse/raft-shared/src/cacheRepoContract.js";
import type { Range } from "@botiverse/raft-shared/src/cacheMerge.js";

type ScopeState = {
  channels: Map<string, { type: string; lastMessageAt: string | null; raw: RawRecord }>;
  messages: Map<string, Map<number, { id: string; raw: RawRecord }>>;
  overlays: Map<string, Map<number, { raw: RawRecord; updatedAt: string | null }>>;
  ranges: Map<string, Range[]>;
  overlayPages: Map<string, OverlayPageInfo>;
  threadSummaries: Map<string, RawRecord>; // `${parentChannelId}:${parentMessageId}`
  taskRows: Map<string, { revision: number; raw: RawRecord }>;
  readStates: Map<string, ReadStateRow>;
  inboxPages: Map<number, RawRecord>;
  kv: Map<string, RawRecord>;
};

function emptyScope(): ScopeState {
  return {
    channels: new Map(),
    messages: new Map(),
    overlays: new Map(),
    ranges: new Map(),
    overlayPages: new Map(),
    threadSummaries: new Map(),
    taskRows: new Map(),
    readStates: new Map(),
    inboxPages: new Map(),
    kv: new Map(),
  };
}

const OVERLAY_PAGE_KEY = (channelId: string, fromSeq: number) => `${channelId}:${fromSeq}`;

export type WebCacheRepoDeps = {
  now?: () => string;
};

export function createWebCacheRepo(deps: WebCacheRepoDeps = {}): CacheRepo {
  const now = deps.now ?? (() => new Date().toISOString());
  const scopes = new Map<number, ScopeState>();
  let nextScopeId = 1;
  // One boot id per repo instance — the overlay once-per-boot refresh gate
  // keys on it (same rule as the mobile repo).
  const bootId = `webboot_${now()}_${Math.random().toString(36).slice(2, 10)}`;

  function scope(scopeId: number): ScopeState | undefined {
    return scopes.get(scopeId);
  }

  function channelMessages(scopeId: number, channelId: string): Map<number, { id: string; raw: RawRecord }> {
    const state = scope(scopeId);
    if (!state) return new Map();
    const bucket = state.messages.get(channelId);
    if (!bucket) {
      const fresh = new Map();
      state.messages.set(channelId, fresh);
      return fresh;
    }
    return bucket;
  }

  function coverageOf(state: ScopeState, channelId: string): Range[] {
    return state.ranges.get(channelId) ?? [];
  }

  function writeRanges(state: ScopeState, channelId: string, ranges: Range[]): void {
    state.ranges.set(channelId, ranges);
  }

  const repo: CacheRepo = {
    bootId,

    async openScope(_origin: string, _userId: string, _serverId: string): Promise<number> {
      // Idempotent per triple — reuse an existing scope when one matches.
      for (const [id, state] of scopes) {
        const identity = state.kv.get("__identity");
        if (
          identity
          && identity.origin === _origin
          && identity.userId === _userId
          && identity.serverId === _serverId
        ) {
          return id;
        }
      }
      const id = nextScopeId++;
      const state = emptyScope();
      state.kv.set("__identity", { origin: _origin, userId: _userId, serverId: _serverId });
      scopes.set(id, state);
      return id;
    },

    async wipeScope(scopeId: number): Promise<void> {
      scopes.delete(scopeId);
    },

    async wipeAll(): Promise<void> {
      scopes.clear();
    },

    async getChannels(scopeId: number, types?: readonly string[]): Promise<CachedChannel[]> {
      const state = scope(scopeId);
      if (!state) return [];
      const out: CachedChannel[] = [];
      for (const [id, row] of state.channels) {
        if (types && types.length > 0 && !types.includes(row.type)) continue;
        out.push({ id, type: row.type, lastMessageAt: row.lastMessageAt, raw: row.raw });
      }
      return out;
    },

    async putChannels(scopeId: number, rows: readonly PutChannelRow[]): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      const ts = now();
      for (const row of rows) {
        state.channels.set(row.id, {
          type: row.type,
          lastMessageAt: row.lastMessageAt ?? null,
          raw: row.raw,
        });
      }
      // dropMissing is type-scoped like the mobile repo: writing the joined
      // channel list must not delete the DM list and vice versa.
      const types = new Set(rows.map((row) => row.type));
      const kept = new Set(rows.map((row) => row.id));
      for (const [id, row] of state.channels) {
        if (types.has(row.type) && !kept.has(id)) state.channels.delete(id);
      }
      void ts;
    },

    async deleteChannel(scopeId: number, channelId: string): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      state.messages.delete(channelId);
      state.overlays.delete(channelId);
      state.ranges.delete(channelId);
      state.readStates.delete(channelId);
      for (const key of state.overlayPages.keys()) {
        if (key.startsWith(`${channelId}:`)) state.overlayPages.delete(key);
      }
    },

    async getCoverage(scopeId: number, channelId: string): Promise<Range[]> {
      const state = scope(scopeId);
      if (!state) return [];
      return coverageOf(state, channelId).map((range) => ({ ...range }));
    },

    async getLatestMessages(scopeId: number, channelId: string, limit: number): Promise<CachedMessage[]> {
      const state = scope(scopeId);
      if (!state) return [];
      const bucket = state.messages.get(channelId);
      const overlays = state.overlays.get(channelId);
      if (!bucket) return [];
      const seqs = [...bucket.keys()].sort((a, b) => b - a).slice(0, limit);
      return seqs.map((seq) => ({
        seq,
        id: bucket.get(seq)!.id,
        raw: bucket.get(seq)!.raw,
        overlay: overlays?.get(seq)?.raw ?? null,
      }));
    },

    async appendPage(scopeId: number, channelId: string, page: AppendPage): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      const bucket = channelMessages(scopeId, channelId);
      for (const message of page.messages) {
        bucket.set(message.seq, { id: message.id, raw: message.raw });
      }
      const range = pageRange(page.messages, page.window);
      if (range) writeRanges(state, channelId, mergeRanges(coverageOf(state, channelId), range));
    },

    async appendLiveMessage(
      scopeId: number,
      channelId: string,
      message: { seq: number; id: string; raw: RawRecord },
      opts: { connected: boolean },
    ): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      const bucket = channelMessages(scopeId, channelId);
      bucket.set(message.seq, { id: message.id, raw: message.raw });
      if (!opts.connected) return;
      const ranges = coverageOf(state, channelId);
      if (!canExtendTailWithLive(ranges, message.seq, true)) return;
      const tail = ranges.find((range) => range.throughSeq + 1 === message.seq);
      if (tail) {
        tail.throughSeq = message.seq;
        writeRanges(state, channelId, ranges.map((range) => ({ ...range })));
      }
    },

    async pruneMessages(scopeId: number, olderThanIso: string): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      for (const [channelId, bucket] of state.messages) {
        for (const [seq, row] of bucket) {
          const createdAt = typeof row.raw.createdAt === "string" ? row.raw.createdAt : null;
          if (createdAt !== null && createdAt < olderThanIso) bucket.delete(seq);
        }
        // Rebuild coverage from survivors (same repair as the mobile repo).
        const survivors = [...bucket.keys()].sort((a, b) => a - b);
        const rebuilt: Range[] = [];
        for (const seq of survivors) {
          const last = rebuilt[rebuilt.length - 1];
          if (last && last.throughSeq + 1 === seq) last.throughSeq = seq;
          else rebuilt.push({ fromSeq: seq, throughSeq: seq });
        }
        writeRanges(state, channelId, rebuilt);
      }
    },

    async applyOverlayPage(scopeId: number, channelId: string, page: OverlayPage): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      const ts = now();
      let overlays = state.overlays.get(channelId);
      if (!overlays) {
        overlays = new Map();
        state.overlays.set(channelId, overlays);
      }
      for (const message of page.messages) {
        overlays.set(message.seq, { raw: message.raw, updatedAt: message.updatedAt ?? ts });
      }
      for (const [parentMessageId, summary] of Object.entries(page.threadSummaries ?? {})) {
        state.threadSummaries.set(`${channelId}:${parentMessageId}`, summary);
      }
      state.overlayPages.set(OVERLAY_PAGE_KEY(channelId, page.fromSeq), {
        throughSeq: page.throughSeq,
        refreshedAt: ts,
        bootId,
      });
    },

    async getOverlayPageInfo(scopeId: number, channelId: string, fromSeq: number): Promise<OverlayPageInfo | null> {
      const state = scope(scopeId);
      if (!state) return null;
      return state.overlayPages.get(OVERLAY_PAGE_KEY(channelId, fromSeq)) ?? null;
    },

    async invalidateOverlayPageMarks(scopeId: number): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      state.overlayPages.clear();
    },

    async applyMessageUpdated(
      scopeId: number,
      channelId: string,
      message: { seq: number; raw: RawRecord; updatedAt?: string | null },
    ): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      let overlays = state.overlays.get(channelId);
      if (!overlays) {
        overlays = new Map();
        state.overlays.set(channelId, overlays);
      }
      const stored = overlays.get(message.seq);
      if (stored && !overlayIsNewer(stored.updatedAt, message.updatedAt ?? now())) return;
      overlays.set(message.seq, { raw: message.raw, updatedAt: message.updatedAt ?? now() });
    },

    async applyThreadSummary(scopeId: number, summary: ThreadSummaryInput): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      state.threadSummaries.set(`${summary.parentChannelId}:${summary.parentMessageId}`, summary.raw);
    },

    async getThreadSummaries(scopeId: number, parentChannelId: string): Promise<Record<string, RawRecord>> {
      const state = scope(scopeId);
      if (!state) return {};
      const out: Record<string, RawRecord> = {};
      for (const [key, raw] of state.threadSummaries) {
        if (key.startsWith(`${parentChannelId}:`)) out[key.slice(parentChannelId.length + 1)] = raw;
      }
      return out;
    },

    async applyTaskEvent(scopeId: number, task: TaskEventInput): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      const stored = state.taskRows.get(task.id);
      const storedRevision = stored ? stored.revision : null;
      // Mirror idbRepo's tie rule: strictly-newer wins; equal revisions only
      // when the caller opts in (live events tie-break, snapshots stay strict).
      const tieAllowed = task.allowTie === true && storedRevision !== null && task.revision === storedRevision;
      if (!taskRevisionGate(storedRevision, task.revision) && !tieAllowed) return;
      state.taskRows.set(task.id, { revision: task.revision, raw: task.raw });
    },

    async deleteTask(scopeId: number, taskId: string): Promise<void> {
      scope(scopeId)?.taskRows.delete(taskId);
    },

    async getTaskRows(scopeId: number): Promise<CachedTaskRow[]> {
      const state = scope(scopeId);
      if (!state) return [];
      return [...state.taskRows.entries()].map(([id, row]) => ({ id, revision: row.revision, raw: row.raw }));
    },

    async applyReadState(scopeId: number, channelId: string, maxReadSeq: number, version: number): Promise<void> {
      const state = scope(scopeId);
      if (!state) return;
      const stored = state.readStates.get(channelId);
      if (stored && stored.version >= version) return;
      state.readStates.set(channelId, { maxReadSeq, version });
    },

    async getReadStates(scopeId: number): Promise<Record<string, ReadStateRow>> {
      const state = scope(scopeId);
      if (!state) return {};
      return Object.fromEntries(state.readStates);
    },

    async getInboxPage(scopeId: number, pageNo: number): Promise<RawRecord | null> {
      return scope(scopeId)?.inboxPages.get(pageNo) ?? null;
    },

    async putInboxPage(scopeId: number, pageNo: number, raw: RawRecord): Promise<void> {
      scope(scopeId)?.inboxPages.set(pageNo, raw);
    },

    async getKv(scopeId: number, key: string): Promise<RawRecord | null> {
      return scope(scopeId)?.kv.get(key) ?? null;
    },

    async putKv(scopeId: number, key: string, value: RawRecord): Promise<void> {
      scope(scopeId)?.kv.set(key, value);
    },
  };

  return repo;
}
