// IndexedDB CacheRepo (desktop-data-cache task #7 / P1).
//
// Web implementation of the shared async storage contract
// (@botiverse/raft-shared/src/cacheRepoContract.ts): one database, twelve
// object stores whose semantics mirror the mobile SQLite schema
// (apps/mobile/src/cache/schema.ts) — scopes partition data by
// (origin, userId, serverId), coverage ranges grow only from server pages or
// a connected live tail, overlays are last-write-wins on server updatedAt,
// task/read-state writes are revision/version gated.
//
// Differences from SQLite that are deliberate:
//   - raw records are stored as structured clones (objects), not JSON text;
//   - messages.messageId carries a NON-unique index — SQLite enforced
//     uniqueness by id while upserting by seq; IndexedDB cannot express both
//     at once, and a re-sequenced duplicate id is tolerable in a disposable
//     cache (server truth wins on the next page);
//   - cross-store read-modify-write operations run inside ONE readwrite
//     transaction, which IndexedDB serializes against other transactions —
//     that is also the multi-tab guarantee the acceptance asks for.
//
// Versioning: the DB version carries the schema version. An existing database
// with a NEWER version (downgrade) cannot be opened — it is deleted and
// rebuilt (cache is disposable by design, same ruling as mobile).

import { deleteDB, openDB } from "idb";
import type { IDBPDatabase } from "idb";
import {
  canExtendTailWithLive,
  contiguousRuns,
  mergeRanges,
  overlayIsNewer,
  pageRange,
  taskRevisionGate,
} from "@botiverse/raft-shared/src/cacheMerge.ts";
import type { Range } from "@botiverse/raft-shared/src/cacheMerge.ts";
import type {
  AppendPage,
  CacheRepo,
  CachedChannel,
  CachedMessage,
  OverlayPage,
  OverlayPageInfo,
  RawRecord,
  ReadStateRow,
  TaskEventInput,
  ThreadSummaryInput,
} from "@botiverse/raft-shared/src/cacheRepoContract.ts";

export const WEB_CACHE_DB_NAME = "raft-web-cache";
export const WEB_CACHE_SCHEMA_VERSION = 1;

const STORES = [
  "scopes",
  "channels",
  "messages",
  "channel_ranges",
  "overlay_pages",
  "message_overlays",
  "thread_summaries",
  "thread_links",
  "task_rows",
  "read_states",
  "inbox_pages",
  "kv",
] as const;

type StoreName = (typeof STORES)[number];

// idb's untyped stores surface optional methods (unknown schema); these
// structural views pin the promise-based surface this repo actually uses.
type AnyCursor = {
  readonly value: unknown;
  continue(): Promise<AnyCursor | null>;
  delete(): Promise<unknown>;
  update(value: unknown): Promise<unknown>;
};
type AnyIndex = {
  get(key: unknown): Promise<unknown>;
  getAll(range?: unknown): Promise<unknown[]>;
  getKey(key: unknown): Promise<unknown>;
};
type AnyStore = {
  get(key: unknown): Promise<unknown>;
  getAll(range?: unknown): Promise<unknown[]>;
  put(value: unknown): Promise<unknown>;
  add(value: unknown): Promise<unknown>;
  delete(key: unknown): Promise<unknown>;
  clear(): Promise<unknown>;
  index(name: string): AnyIndex;
  openCursor(range?: unknown, direction?: IDBCursorDirection): Promise<AnyCursor | null>;
};
type AnyTx = { objectStore(name: StoreName): AnyStore; readonly done: Promise<void> };

/** All rows of one scope: [scopeId] ≤ key < [scopeId, []] (arrays sort after scalars). */
function scopeRange(scopeId: number): IDBKeyRange {
  return IDBKeyRange.bound([scopeId], [scopeId, []]);
}

/** All rows of one channel (stores keyed [scopeId, channelId, …]). */
function channelRange(scopeId: number, channelId: string): IDBKeyRange {
  return IDBKeyRange.bound([scopeId, channelId], [scopeId, channelId, []]);
}

export type IdbRepoDeps = {
  /** Injectable clock for deterministic updatedAt/bookkeeping in tests. */
  now?: () => string;
};

async function openRaw(): Promise<IDBPDatabase> {
  try {
    return await openDB(WEB_CACHE_DB_NAME, WEB_CACHE_SCHEMA_VERSION, { upgrade });
  } catch (error) {
    // A database newer than this code (downgrade) cannot be opened at our
    // version — dispose of it and rebuild. The cache is disposable.
    if (!(error instanceof Error) || error.name !== "VersionError") throw error;
    await deleteDB(WEB_CACHE_DB_NAME);
    return openDB(WEB_CACHE_DB_NAME, WEB_CACHE_SCHEMA_VERSION, { upgrade });
  }
}

function upgrade(db: IDBPDatabase): void {
  const scopes = db.createObjectStore("scopes", { keyPath: "id", autoIncrement: true });
  scopes.createIndex("identity", ["origin", "userId", "serverId"], { unique: true });
  db.createObjectStore("channels", { keyPath: ["scopeId", "channelId"] });
  const messages = db.createObjectStore("messages", { keyPath: ["scopeId", "channelId", "seq"] });
  messages.createIndex("byId", ["scopeId", "channelId", "messageId"]);
  db.createObjectStore("channel_ranges", { keyPath: ["scopeId", "channelId", "fromSeq"] });
  db.createObjectStore("overlay_pages", { keyPath: ["scopeId", "channelId", "fromSeq"] });
  db.createObjectStore("message_overlays", { keyPath: ["scopeId", "channelId", "seq"] });
  db.createObjectStore("thread_summaries", { keyPath: ["scopeId", "parentChannelId", "parentMessageId"] });
  const threadLinks = db.createObjectStore("thread_links", { keyPath: ["scopeId", "threadChannelId"] });
  threadLinks.createIndex("byParent", ["scopeId", "parentChannelId"]);
  db.createObjectStore("task_rows", { keyPath: ["scopeId", "taskId"] });
  db.createObjectStore("read_states", { keyPath: ["scopeId", "channelId"] });
  db.createObjectStore("inbox_pages", { keyPath: ["scopeId", "pageNo"] });
  db.createObjectStore("kv", { keyPath: ["scopeId", "key"] });
}

type MessageRow = {
  scopeId: number;
  channelId: string;
  seq: number;
  messageId: string;
  senderType: string | null;
  senderId: string | null;
  sentAt: string | null;
  raw: RawRecord;
};

function messageRow(scopeId: number, channelId: string, seq: number, id: string, raw: RawRecord): MessageRow {
  return {
    scopeId,
    channelId,
    seq,
    messageId: id,
    senderType: typeof raw.senderType === "string" ? raw.senderType : null,
    senderId: typeof raw.senderId === "string" ? raw.senderId : null,
    sentAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    raw,
  };
}

async function coverageOf(store: AnyStore, scopeId: number, channelId: string): Promise<Range[]> {
  const rows = (await store.getAll(channelRange(scopeId, channelId))) as Array<{ fromSeq: number; throughSeq: number }>;
  return rows
    .map((row) => ({ fromSeq: Number(row.fromSeq), throughSeq: Number(row.throughSeq) }))
    .sort((a, b) => a.fromSeq - b.fromSeq);
}

/**
 * Open the cache database and return the contract implementation. Rejects on
 * genuine open failures (quota, privacy mode); the caller decides whether to
 * degrade to the no-op repo.
 */
export async function createIdbCacheRepo(deps: IdbRepoDeps = {}): Promise<CacheRepo> {
  const db = await openRaw();
  const tx = (mode: IDBTransactionMode): AnyTx => db.transaction(STORES as unknown as string[], mode) as unknown as AnyTx;
  const now = deps.now ?? (() => new Date().toISOString());
  const bootId = globalThis.crypto?.randomUUID?.() ?? `boot-${now()}-${Math.random().toString(36).slice(2)}`;
  const rw = () => tx("readwrite");
  const ro = () => tx("readonly");

  const repo: CacheRepo = {
    bootId,

    async openScope(origin, userId, serverId) {
      const t = rw();
      const existing = (await t.objectStore("scopes").index("identity").get([origin, userId, serverId])) as
        | { id?: number }
        | undefined;
      if (existing && typeof existing.id === "number") {
        await t.done;
        return existing.id;
      }
      const id = Number(await t.objectStore("scopes").add({ origin, userId, serverId, createdAt: now() }));
      await t.done;
      return id;
    },

    async wipeScope(scopeId) {
      const t = rw();
      for (const store of STORES) {
        if (store === "scopes") continue;
        t.objectStore(store).delete(scopeRange(scopeId));
      }
      t.objectStore("scopes").delete(scopeId);
      await t.done;
    },

    async wipeAll() {
      const t = rw();
      for (const store of STORES) t.objectStore(store).clear();
      await t.done;
    },

    async getChannels(scopeId, types): Promise<CachedChannel[]> {
      const rows = (await ro().objectStore("channels").getAll(scopeRange(scopeId))) as Array<{
        channelId: string;
        type: string;
        lastMessageAt: string | null;
        raw: RawRecord;
      }>;
      const wanted = types && types.length > 0 ? new Set(types) : null;
      return rows
        .filter((row) => wanted === null || wanted.has(row.type))
        .map((row) => ({ id: String(row.channelId), type: String(row.type), lastMessageAt: row.lastMessageAt ?? null, raw: row.raw ?? {} }));
    },

    async putChannels(scopeId, rows) {
      const t = rw();
      const channels = t.objectStore("channels");
      const ts = now();
      for (const row of rows) {
        channels.put({ scopeId, channelId: row.id, type: row.type, lastMessageAt: row.lastMessageAt ?? null, raw: row.raw, updatedAt: ts });
      }
      const types = [...new Set(rows.map((row) => row.type))];
      if (types.length === 0) {
        await t.done;
        return;
      }
      const wanted = new Set(types);
      const kept = new Set(rows.map((row) => row.id));
      const existing = (await channels.getAll(scopeRange(scopeId))) as Array<{ channelId: string; type: string }>;
      for (const row of existing) {
        if (!wanted.has(row.type) || kept.has(String(row.channelId))) continue;
        await deleteChannelInTx(t, scopeId, String(row.channelId));
      }
      await t.done;
    },

    async deleteChannel(scopeId, channelId) {
      const t = rw();
      await deleteChannelInTx(t, scopeId, channelId);
      await t.done;
    },

    async getCoverage(scopeId, channelId) {
      return coverageOf(ro().objectStore("channel_ranges"), scopeId, channelId);
    },

    async getLatestMessages(scopeId, channelId, limit): Promise<CachedMessage[]> {
      const t = ro();
      const messages = t.objectStore("messages");
      const overlays = t.objectStore("message_overlays");
      const out: CachedMessage[] = [];
      let cursor = await messages.openCursor(channelRange(scopeId, channelId), "prev");
      while (cursor && out.length < limit) {
        const row = cursor.value as MessageRow;
        const overlay = (await overlays.get([scopeId, channelId, row.seq])) as { raw?: RawRecord } | undefined;
        out.push({ seq: Number(row.seq), id: String(row.messageId), raw: row.raw ?? {}, overlay: overlay?.raw ?? null });
        cursor = await cursor.continue();
      }
      await t.done;
      return out;
    },

    async appendPage(scopeId, channelId, page: AppendPage) {
      const t = rw();
      const messages = t.objectStore("messages");
      for (const message of page.messages) {
        messages.put(messageRow(scopeId, channelId, message.seq, message.id, message.raw));
      }
      const range = pageRange(page.messages, page.window);
      if (range) await recordRangeInTx(t, scopeId, channelId, range);
      await t.done;
    },

    async appendLiveMessage(scopeId, channelId, message, opts) {
      const t = rw();
      t.objectStore("messages").put(messageRow(scopeId, channelId, message.seq, message.id, message.raw));
      if (opts.connected) {
        const coverage = await coverageOf(t.objectStore("channel_ranges"), scopeId, channelId);
        if (canExtendTailWithLive(coverage, message.seq, true)) {
          const tail = coverage.find((range) => range.throughSeq + 1 === message.seq);
          if (tail) {
            t.objectStore("channel_ranges").put({ scopeId, channelId, fromSeq: tail.fromSeq, throughSeq: message.seq });
          }
        }
      }
      await t.done;
    },

    async pruneMessages(scopeId, olderThanIso) {
      const t = rw();
      const messages = t.objectStore("messages");
      const overlays = t.objectStore("message_overlays");
      const rangeStore = t.objectStore("channel_ranges");
      const pages = t.objectStore("overlay_pages");
      const channelIds = new Set<string>();
      let cursor = await messages.openCursor(scopeRange(scopeId));
      while (cursor) {
        const row = cursor.value as MessageRow;
        channelIds.add(String(row.channelId));
        if (row.sentAt !== null && row.sentAt < olderThanIso) await cursor.delete();
        cursor = await cursor.continue();
      }
      for (const channelId of channelIds) {
        const survivors: number[] = [];
        let scan = await messages.openCursor(channelRange(scopeId, channelId));
        while (scan) {
          survivors.push(Number((scan.value as MessageRow).seq));
          scan = await scan.continue();
        }
        survivors.sort((a, b) => a - b);
        // Overlay orphans: dynamic data for messages that no longer exist.
        let overlayCursor = await overlays.openCursor(channelRange(scopeId, channelId));
        while (overlayCursor) {
          const seq = Number((overlayCursor.value as { seq: number }).seq);
          if (!survivors.includes(seq)) await overlayCursor.delete();
          overlayCursor = await overlayCursor.continue();
        }
        rangeStore.delete(channelRange(scopeId, channelId));
        for (const run of contiguousRuns(survivors)) {
          rangeStore.put({ scopeId, channelId, fromSeq: run.fromSeq, throughSeq: run.throughSeq });
        }
        if (survivors.length > 0) {
          const floor = survivors[0];
          let pageCursor = await pages.openCursor(channelRange(scopeId, channelId));
          while (pageCursor) {
            const row = pageCursor.value as { fromSeq: number; throughSeq: number };
            if (row.throughSeq < floor) {
              await pageCursor.delete();
            } else if (row.fromSeq < floor) {
              // Cursor update cannot rewrite a keyPath value (DataError) —
              // delete + put moves the row, same as the SQL UPDATE.
              await pageCursor.delete();
              pages.put({ ...row, fromSeq: floor });
            }
            pageCursor = await pageCursor.continue();
          }
        } else {
          pages.delete(channelRange(scopeId, channelId));
        }
      }
      // Thread summaries whose parent message is gone (messageId lookup).
      const byId = messages.index("byId");
      let summaryCursor = await t.objectStore("thread_summaries").openCursor(scopeRange(scopeId));
      while (summaryCursor) {
        const row = summaryCursor.value as { parentChannelId: string; parentMessageId: string };
        const parent = await byId.getKey([scopeId, row.parentChannelId, row.parentMessageId]);
        if (parent === undefined) await summaryCursor.delete();
        summaryCursor = await summaryCursor.continue();
      }
      await t.done;
    },

    async applyOverlayPage(scopeId, channelId, page: OverlayPage) {
      const t = rw();
      const ts = now();
      for (const message of page.messages) {
        await writeOverlayInTx(t, scopeId, channelId, message.seq, message.raw, message.updatedAt ?? ts, ts);
      }
      for (const [parentMessageId, summary] of Object.entries(page.threadSummaries ?? {})) {
        await writeThreadSummaryInTx(t, scopeId, channelId, parentMessageId, summary, ts);
      }
      t.objectStore("overlay_pages").put({
        scopeId,
        channelId,
        fromSeq: page.fromSeq,
        throughSeq: page.throughSeq,
        refreshedAt: ts,
        bootId,
      });
      await t.done;
    },

    async getOverlayPageInfo(scopeId, channelId, fromSeq): Promise<OverlayPageInfo | null> {
      const row = (await ro().objectStore("overlay_pages").get([scopeId, channelId, fromSeq])) as OverlayPageInfo | undefined;
      return row ?? null;
    },

    async invalidateOverlayPageMarks(scopeId) {
      const t = rw();
      t.objectStore("overlay_pages").delete(scopeRange(scopeId));
      await t.done;
    },

    async applyMessageUpdated(scopeId, channelId, message) {
      const t = rw();
      const ts = now();
      await writeOverlayInTx(t, scopeId, channelId, message.seq, message.raw, message.updatedAt ?? ts, ts);
      await t.done;
    },

    async applyThreadSummary(scopeId, summary: ThreadSummaryInput) {
      const t = rw();
      await writeThreadSummaryInTx(t, scopeId, summary.parentChannelId, summary.parentMessageId, summary.raw, now());
      await t.done;
    },

    async getThreadSummaries(scopeId, parentChannelId) {
      const rows = (await ro().objectStore("thread_summaries").getAll(channelRange(scopeId, parentChannelId))) as Array<{
        parentMessageId: string;
        raw?: RawRecord;
      }>;
      const out: Record<string, RawRecord> = {};
      for (const row of rows) {
        if (row.raw && typeof row.raw === "object") out[String(row.parentMessageId)] = row.raw;
      }
      return out;
    },

    async applyTaskEvent(scopeId, task: TaskEventInput) {
      const t = rw();
      const stored = (await t.objectStore("task_rows").get([scopeId, task.id])) as { revision?: number } | undefined;
      const storedRevision = stored ? Number(stored.revision) : null;
      if (taskRevisionGate(storedRevision, task.revision)) {
        t.objectStore("task_rows").put({ scopeId, taskId: task.id, revision: task.revision, raw: task.raw, updatedAt: now() });
      }
      await t.done;
    },

    async deleteTask(scopeId, taskId) {
      const t = rw();
      t.objectStore("task_rows").delete([scopeId, taskId]);
      await t.done;
    },

    async getTaskRows(scopeId) {
      const rows = (await ro().objectStore("task_rows").getAll(scopeRange(scopeId))) as Array<{
        taskId: string;
        revision: number;
        raw?: RawRecord;
      }>;
      return rows.map((row) => ({ id: String(row.taskId), revision: Number(row.revision), raw: row.raw ?? {} }));
    },

    async applyReadState(scopeId, channelId, maxReadSeq, version) {
      const t = rw();
      const stored = (await t.objectStore("read_states").get([scopeId, channelId])) as { version?: number } | undefined;
      if (!stored || Number(stored.version) < version) {
        t.objectStore("read_states").put({ scopeId, channelId, maxReadSeq, version });
      }
      await t.done;
    },

    async getReadStates(scopeId) {
      const rows = (await ro().objectStore("read_states").getAll(scopeRange(scopeId))) as Array<{
        channelId: string;
        maxReadSeq: number;
        version: number;
      }>;
      const out: Record<string, ReadStateRow> = {};
      for (const row of rows) out[String(row.channelId)] = { maxReadSeq: Number(row.maxReadSeq), version: Number(row.version) };
      return out;
    },

    async getInboxPage(scopeId, pageNo) {
      const row = (await ro().objectStore("inbox_pages").get([scopeId, pageNo])) as { raw?: RawRecord } | undefined;
      return row?.raw && typeof row.raw === "object" ? row.raw : null;
    },

    async putInboxPage(scopeId, pageNo, raw) {
      const t = rw();
      t.objectStore("inbox_pages").put({ scopeId, pageNo, raw, fetchedAt: now() });
      await t.done;
    },

    async getKv(scopeId, key) {
      const row = (await ro().objectStore("kv").get([scopeId, key])) as { value?: RawRecord } | undefined;
      return row?.value && typeof row.value === "object" ? row.value : null;
    },

    async putKv(scopeId, key, value) {
      const t = rw();
      t.objectStore("kv").put({ scopeId, key, value });
      await t.done;
    },
  };

  return repo;
}

// ---- transaction-internal helpers (mirroring the mobile repo's *Tx fns) ----

async function recordRangeInTx(t: AnyTx, scopeId: number, channelId: string, range: Range): Promise<void> {
  const store = t.objectStore("channel_ranges");
  const existing = await coverageOf(store, scopeId, channelId);
  const merged = mergeRanges(existing, range);
  store.delete(channelRange(scopeId, channelId));
  for (const row of merged) {
    store.put({ scopeId, channelId, fromSeq: row.fromSeq, throughSeq: row.throughSeq });
  }
}

async function writeOverlayInTx(
  t: AnyTx,
  scopeId: number,
  channelId: string,
  seq: number,
  raw: RawRecord,
  effectiveAt: string,
  writeTs: string,
): Promise<void> {
  const store = t.objectStore("message_overlays");
  const stored = (await store.get([scopeId, channelId, seq])) as { updatedAt?: string } | undefined;
  if (stored) {
    const storedUpdatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : null;
    if (!overlayIsNewer(storedUpdatedAt, effectiveAt)) return;
  }
  store.put({ scopeId, channelId, seq, raw, updatedAt: writeTs });
}

async function writeThreadSummaryInTx(
  t: AnyTx,
  scopeId: number,
  parentChannelId: string,
  parentMessageId: string,
  summary: RawRecord & { threadChannelId?: string },
  ts: string,
): Promise<void> {
  t.objectStore("thread_summaries").put({ scopeId, parentChannelId, parentMessageId, raw: summary, updatedAt: ts });
  if (typeof summary.threadChannelId === "string" && summary.threadChannelId) {
    t.objectStore("thread_links").put({ scopeId, threadChannelId: summary.threadChannelId, parentChannelId, parentMessageId });
  }
}

async function deleteChannelInTx(t: AnyTx, scopeId: number, channelId: string): Promise<void> {
  const threadRows = (await t.objectStore("thread_links").index("byParent").getAll(channelRange(scopeId, channelId))) as Array<{
    threadChannelId: string;
  }>;
  const channelIds = [channelId, ...threadRows.map((row) => String(row.threadChannelId))];
  for (const id of channelIds) {
    for (const store of ["messages", "channel_ranges", "overlay_pages", "message_overlays", "read_states"] as const) {
      t.objectStore(store).delete(channelRange(scopeId, id));
    }
  }
  t.objectStore("thread_summaries").delete(channelRange(scopeId, channelId));
  const links = t.objectStore("thread_links");
  const scopeLinks = (await links.getAll(scopeRange(scopeId))) as Array<{ parentChannelId: string; threadChannelId: string }>;
  for (const row of scopeLinks) {
    if (row.parentChannelId === channelId || row.threadChannelId === channelId) {
      links.delete([scopeId, row.threadChannelId]);
    }
  }
  t.objectStore("channels").delete([scopeId, channelId]);
}
