// Local cache repository (client-data-cache task #1, approved draft).
//
// Pure storage + merge layer: no network, no UI, no React. Callers (task #2
// boot fast-path, task #3 write-through) fetch data and hand it here; this
// layer owns persistence, coverage-range accounting and idempotent merges.
//
// Concurrency model: reads are synchronous point lookups (cold-start paint);
// the only synchronous writes are the one-shot schema/scope bootstrap. Every
// data mutation runs in one EXCLUSIVE async transaction with async
// statements, so realtime bursts never block the JS thread and no other
// statement can fold into an open transaction (Firstmate review notes).
//
// Cascades (review note #4): deleting a channel removes its thread channels'
// messages/ranges/overlays/read-states too, via thread_links. Pruning
// rebuilds coverage ranges from the surviving seqs (merge.contiguousRuns).

import { decodeJson, encodeJson, type SqliteDb, type WriteTx } from "./port";
import {
  canExtendTailWithLive,
  contiguousRuns,
  mergeRanges,
  overlayIsNewer,
  pageRange,
  taskRevisionGate,
  type MessageWindowCoverage,
  type Range,
} from "./merge";
import { ensureSchema } from "./schema";

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

export type CacheRepoDeps = {
  db: SqliteDb;
  now?: () => string;
};

const DATA_TABLES = [
  "thread_links",
  "thread_summaries",
  "message_overlays",
  "overlay_pages",
  "channel_ranges",
  "messages",
  "task_rows",
  "read_states",
  "inbox_pages",
  "channels",
  "kv",
] as const;

export function createCacheRepo(deps: CacheRepoDeps) {
  const db = deps.db;
  const now = deps.now ?? (() => new Date().toISOString());
  ensureSchema(db);
  // One boot id per repo instance = one per app launch (the overlay
  // once-per-boot rule consumed by task #3 lives in overlay_pages bookkeeping).
  const bootId = `boot_${now()}_${Math.random().toString(36).slice(2, 10)}`;

  // ---- scope management --------------------------------------------------

  /** Bootstrap-time idempotent scope open. Returns the scopeId. */
  function openScope(origin: string, userId: string, serverId: string): number {
    db.run(
      "INSERT OR IGNORE INTO scopes (origin, userId, serverId, createdAt) VALUES (?, ?, ?, ?)",
      [origin, userId, serverId, now()],
    );
    const row = db.all(
      "SELECT id FROM scopes WHERE origin = ? AND userId = ? AND serverId = ?",
      [origin, userId, serverId],
    )[0];
    return Number(row?.id ?? 0);
  }

  async function wipeScope(scopeId: number): Promise<void> {
    await db.write(async (tx) => {
      for (const table of DATA_TABLES) await tx.run(`DELETE FROM ${table} WHERE scopeId = ?`, [scopeId]);
      await tx.run("DELETE FROM scopes WHERE id = ?", [scopeId]);
    });
  }

  async function wipeAll(): Promise<void> {
    await db.write(async (tx) => {
      for (const table of [...DATA_TABLES, "scopes"]) await tx.run(`DELETE FROM ${table}`);
    });
  }

  // ---- channels (joined channels AND DMs share this table, note #5) ------

  function getChannels(
    scopeId: number,
    types?: readonly string[],
  ): Array<{ id: string; type: string; lastMessageAt: string | null; raw: RawRecord }> {
    const rows =
      types && types.length > 0
        ? db.all(
            `SELECT channelId, type, lastMessageAt, raw FROM channels
             WHERE scopeId = ? AND type IN (${types.map(() => "?").join(",")})`,
            [scopeId, ...types],
          )
        : db.all("SELECT channelId, type, lastMessageAt, raw FROM channels WHERE scopeId = ?", [scopeId]);
    return rows.map((row) => ({
      id: String(row.channelId),
      type: String(row.type),
      lastMessageAt: row.lastMessageAt === null ? null : String(row.lastMessageAt),
      raw: decodeJson<RawRecord>(row.raw) ?? {},
    }));
  }

  /**
   * Upsert directory rows. `dropMissing` deletes cached channels that are no
   * longer listed — scoped to the TYPE SET of this batch, so writing the
   * joined-channel list never deletes the DM list and vice versa. Deletion
   * cascades into the dropped channels' thread data (review note #4).
   */
  async function putChannels(scopeId: number, rows: readonly PutChannelRow[]): Promise<void> {
    await db.write(async (tx) => {
      const ts = now();
      for (const row of rows) {
        await tx.run(
          `INSERT INTO channels (scopeId, channelId, type, lastMessageAt, raw, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scopeId, channelId) DO UPDATE SET
             type = excluded.type,
             lastMessageAt = excluded.lastMessageAt,
             raw = excluded.raw,
             updatedAt = excluded.updatedAt`,
          [scopeId, row.id, row.type, row.lastMessageAt ?? null, encodeJson(row.raw), ts],
        );
      }
      const types = [...new Set(rows.map((row) => row.type))];
      if (types.length === 0) return;
      const kept = rows.map((row) => row.id);
      const stale = db.all(
        `SELECT channelId FROM channels
         WHERE scopeId = ? AND type IN (${types.map(() => "?").join(",")})
           AND channelId NOT IN (${kept.length > 0 ? kept.map(() => "?").join(",") : "SELECT '' WHERE 1=0"})`,
        [scopeId, ...types, ...kept],
      );
      for (const row of stale) await deleteChannelTx(tx, scopeId, String(row.channelId));
    });
  }

  // ---- messages + coverage ranges -----------------------------------------

  function getCoverage(scopeId: number, channelId: string): Range[] {
    return db
      .all(
        "SELECT fromSeq, throughSeq FROM channel_ranges WHERE scopeId = ? AND channelId = ? ORDER BY fromSeq",
        [scopeId, channelId],
      )
      .map((row) => ({ fromSeq: Number(row.fromSeq), throughSeq: Number(row.throughSeq) }));
  }

  function getLatestMessages(scopeId: number, channelId: string, limit: number): CachedMessage[] {
    const rows = db.all(
      `SELECT m.seq, m.messageId, m.bodyRaw, o.raw AS overlayRaw
       FROM messages m
       LEFT JOIN message_overlays o
         ON o.scopeId = m.scopeId AND o.channelId = m.channelId AND o.seq = m.seq
       WHERE m.scopeId = ? AND m.channelId = ?
       ORDER BY m.seq DESC
       LIMIT ?`,
      [scopeId, channelId, limit],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      id: String(row.messageId),
      raw: decodeJson<RawRecord>(row.bodyRaw) ?? {},
      overlay: decodeJson<RawRecord>(row.overlayRaw),
    }));
  }

  /**
   * Atomic ingest of one server page (fetch page, sync batch, or context
   * window). Establishes/extends coverage from the server's contiguous
   * result — the ONLY writer allowed to create ranges besides a connected
   * live tail message (review note #1).
   */
  async function appendPage(scopeId: number, channelId: string, page: AppendPage): Promise<void> {
    await db.write(async (tx) => {
      for (const message of page.messages) {
        await upsertMessageTx(tx, scopeId, channelId, message.seq, message.id, message.raw);
      }
      const range = pageRange(page.messages, page.window);
      if (range) await recordRangeTx(tx, scopeId, channelId, range);
    });
  }

  /**
   * Realtime message:new write-through. The message is ALWAYS stored; the
   * coverage tail is extended only when the message directly follows the
   * tail AND the socket stayed connected — otherwise the gap stays open for
   * the next sync to fill (review note #1).
   */
  async function appendLiveMessage(
    scopeId: number,
    channelId: string,
    message: { seq: number; id: string; raw: RawRecord },
    opts: { connected: boolean },
  ): Promise<void> {
    await db.write(async (tx) => {
      await upsertMessageTx(tx, scopeId, channelId, message.seq, message.id, message.raw);
      if (!opts.connected) return;
      const ranges = getCoverage(scopeId, channelId);
      if (!canExtendTailWithLive(ranges, message.seq, true)) return;
      const tail = ranges.find((range) => range.throughSeq + 1 === message.seq);
      if (tail) {
        await tx.run(
          "UPDATE channel_ranges SET throughSeq = ? WHERE scopeId = ? AND channelId = ? AND fromSeq = ?",
          [message.seq, scopeId, channelId, tail.fromSeq],
        );
      }
    });
  }

  /** A re-fetched page overwrites the dynamic data of its span (note #2). */
  async function applyOverlayPage(scopeId: number, channelId: string, page: OverlayPage): Promise<void> {
    await db.write(async (tx) => {
      const ts = now();
      for (const message of page.messages) {
        await writeOverlayTx(tx, scopeId, channelId, message.seq, message.raw, message.updatedAt ?? ts, ts);
      }
      for (const [parentMessageId, summary] of Object.entries(page.threadSummaries ?? {})) {
        await writeThreadSummaryTx(tx, scopeId, channelId, parentMessageId, summary, ts);
      }
      await tx.run(
        `INSERT INTO overlay_pages (scopeId, channelId, fromSeq, throughSeq, refreshedAt, bootId)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scopeId, channelId, fromSeq) DO UPDATE SET
           throughSeq = excluded.throughSeq,
           refreshedAt = excluded.refreshedAt,
           bootId = excluded.bootId`,
        [scopeId, channelId, page.fromSeq, page.throughSeq, ts, bootId],
      );
    });
  }

  /** Overlay-page bookkeeping read for task #3's once-per-boot refresh gate. */
  function getOverlayPageInfo(
    scopeId: number,
    channelId: string,
    fromSeq: number,
  ): { throughSeq: number; refreshedAt: string; bootId: string } | null {
    const row = db.all(
      "SELECT throughSeq, refreshedAt, bootId FROM overlay_pages WHERE scopeId = ? AND channelId = ? AND fromSeq = ?",
      [scopeId, channelId, fromSeq],
    )[0];
    if (!row) return null;
    return {
      throughSeq: Number(row.throughSeq),
      refreshedAt: String(row.refreshedAt),
      bootId: String(row.bootId),
    };
  }

  /**
   * Drop the once-per-boot refresh markers for the whole scope WITHOUT
   * touching the overlay data itself: a disconnect invalidates "already
   * refreshed this boot" for every page (anything may have changed while the
   * socket was down), so the reconnect refresh re-pulls instead of being
   * gated out (desktop-data-cache task #2).
   */
  async function invalidateOverlayPageMarks(scopeId: number): Promise<void> {
    await db.write(async (tx) => {
      await tx.run("DELETE FROM overlay_pages WHERE scopeId = ?", [scopeId]);
    });
  }

  /** message:updated write-through (reactions and other projections). */
  async function applyMessageUpdated(
    scopeId: number,
    channelId: string,
    message: { seq: number; raw: RawRecord; updatedAt?: string | null },
  ): Promise<void> {
    await db.write(async (tx) => {
      const ts = now();
      await writeOverlayTx(tx, scopeId, channelId, message.seq, message.raw, message.updatedAt ?? ts, ts);
    });
  }

  /** thread:updated / threads-endpoint write-through. */
  async function applyThreadSummary(scopeId: number, summary: ThreadSummaryInput): Promise<void> {
    await db.write(async (tx) => {
      await writeThreadSummaryTx(
        tx,
        scopeId,
        summary.parentChannelId,
        summary.parentMessageId,
        summary.raw,
        now(),
      );
    });
  }

  function getThreadSummaries(scopeId: number, parentChannelId: string): Record<string, RawRecord> {
    const rows = db.all(
      "SELECT parentMessageId, raw FROM thread_summaries WHERE scopeId = ? AND parentChannelId = ?",
      [scopeId, parentChannelId],
    );
    const out: Record<string, RawRecord> = {};
    for (const row of rows) {
      const decoded = decodeJson<RawRecord>(row.raw);
      if (decoded) out[String(row.parentMessageId)] = decoded;
    }
    return out;
  }

  // ---- tasks ---------------------------------------------------------------

  async function applyTaskEvent(scopeId: number, task: TaskEventInput): Promise<void> {
    await db.write(async (tx) => {
      const stored = db.all(
        "SELECT revision FROM task_rows WHERE scopeId = ? AND taskId = ?",
        [scopeId, task.id],
      )[0];
      const storedRevision = stored ? Number(stored.revision) : null;
      if (!taskRevisionGate(storedRevision, task.revision)) return;
      await tx.run(
        `INSERT INTO task_rows (scopeId, taskId, revision, raw, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scopeId, taskId) DO UPDATE SET
           revision = excluded.revision,
           raw = excluded.raw,
           updatedAt = excluded.updatedAt`,
        [scopeId, task.id, task.revision, encodeJson(task.raw), now()],
      );
    });
  }

  async function deleteTask(scopeId: number, taskId: string): Promise<void> {
    await db.write(async (tx) => {
      await tx.run("DELETE FROM task_rows WHERE scopeId = ? AND taskId = ?", [scopeId, taskId]);
    });
  }

  function getTaskRows(scopeId: number): Array<{ id: string; revision: number; raw: RawRecord }> {
    return db
      .all("SELECT taskId, revision, raw FROM task_rows WHERE scopeId = ?", [scopeId])
      .map((row) => ({
        id: String(row.taskId),
        revision: Number(row.revision),
        raw: decodeJson<RawRecord>(row.raw) ?? {},
      }));
  }

  // ---- read states / inbox / kv ---------------------------------------------

  async function applyReadState(
    scopeId: number,
    channelId: string,
    maxReadSeq: number,
    version: number,
  ): Promise<void> {
    await db.write(async (tx) => {
      const stored = db.all(
        "SELECT version FROM read_states WHERE scopeId = ? AND channelId = ?",
        [scopeId, channelId],
      )[0];
      if (stored && Number(stored.version) >= version) return;
      await tx.run(
        `INSERT INTO read_states (scopeId, channelId, maxReadSeq, version)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (scopeId, channelId) DO UPDATE SET
           maxReadSeq = excluded.maxReadSeq,
           version = excluded.version`,
        [scopeId, channelId, maxReadSeq, version],
      );
    });
  }

  function getReadStates(scopeId: number): Record<string, { maxReadSeq: number; version: number }> {
    const rows = db.all(
      "SELECT channelId, maxReadSeq, version FROM read_states WHERE scopeId = ?",
      [scopeId],
    );
    const out: Record<string, { maxReadSeq: number; version: number }> = {};
    for (const row of rows) {
      out[String(row.channelId)] = { maxReadSeq: Number(row.maxReadSeq), version: Number(row.version) };
    }
    return out;
  }

  function getInboxPage(scopeId: number, pageNo: number): RawRecord | null {
    const row = db.all("SELECT raw FROM inbox_pages WHERE scopeId = ? AND pageNo = ?", [scopeId, pageNo])[0];
    return decodeJson<RawRecord>(row?.raw);
  }

  async function putInboxPage(scopeId: number, pageNo: number, raw: RawRecord): Promise<void> {
    await db.write(async (tx) => {
      await tx.run(
        `INSERT INTO inbox_pages (scopeId, pageNo, raw, fetchedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (scopeId, pageNo) DO UPDATE SET
           raw = excluded.raw,
           fetchedAt = excluded.fetchedAt`,
        [scopeId, pageNo, encodeJson(raw), now()],
      );
    });
  }

  function getKv(scopeId: number, key: string): RawRecord | null {
    const row = db.all("SELECT value FROM kv WHERE scopeId = ? AND key = ?", [scopeId, key])[0];
    return decodeJson<RawRecord>(row?.value);
  }

  async function putKv(scopeId: number, key: string, value: RawRecord): Promise<void> {
    await db.write(async (tx) => {
      await tx.run(
        `INSERT INTO kv (scopeId, key, value) VALUES (?, ?, ?)
         ON CONFLICT (scopeId, key) DO UPDATE SET value = excluded.value`,
        [scopeId, key, encodeJson(value)],
      );
    });
  }

  // ---- deletion / pruning (note #4: cascades) -------------------------------

  async function deleteChannel(scopeId: number, channelId: string): Promise<void> {
    await db.write(async (tx) => deleteChannelTx(tx, scopeId, channelId));
  }

  /**
   * Drop messages older than the cutoff (plan history limit) and repair the
   * bookkeeping: overlay orphans, coverage ranges (rebuilt from survivors)
   * and overlay-page rows (dropped/clamped below the surviving floor).
   */
  async function pruneMessages(scopeId: number, olderThanIso: string): Promise<void> {
    await db.write(async (tx) => {
      const channels = db.all("SELECT DISTINCT channelId FROM messages WHERE scopeId = ?", [scopeId]);
      for (const channelRow of channels) {
        const channelId = String(channelRow.channelId);
        await tx.run(
          `DELETE FROM messages
           WHERE scopeId = ? AND channelId = ? AND sentAt IS NOT NULL AND sentAt < ?`,
          [scopeId, channelId, olderThanIso],
        );
        await tx.run(
          `DELETE FROM message_overlays
           WHERE scopeId = ? AND channelId = ?
             AND seq NOT IN (SELECT seq FROM messages WHERE scopeId = ? AND channelId = ?)`,
          [scopeId, channelId, scopeId, channelId],
        );
        const remaining = db
          .all("SELECT seq FROM messages WHERE scopeId = ? AND channelId = ? ORDER BY seq", [scopeId, channelId])
          .map((row) => Number(row.seq));
        await tx.run("DELETE FROM channel_ranges WHERE scopeId = ? AND channelId = ?", [scopeId, channelId]);
        for (const run of contiguousRuns(remaining)) {
          await tx.run(
            "INSERT INTO channel_ranges (scopeId, channelId, fromSeq, throughSeq) VALUES (?, ?, ?, ?)",
            [scopeId, channelId, run.fromSeq, run.throughSeq],
          );
        }
        if (remaining.length > 0) {
          const floor = remaining[0];
          await tx.run(
            "DELETE FROM overlay_pages WHERE scopeId = ? AND channelId = ? AND throughSeq < ?",
            [scopeId, channelId, floor],
          );
          await tx.run(
            "UPDATE overlay_pages SET fromSeq = ? WHERE scopeId = ? AND channelId = ? AND fromSeq < ?",
            [floor, scopeId, channelId, floor],
          );
        } else {
          await tx.run("DELETE FROM overlay_pages WHERE scopeId = ? AND channelId = ?", [scopeId, channelId]);
        }
      }
      await tx.run(
        `DELETE FROM thread_summaries WHERE scopeId = ? AND NOT EXISTS (
           SELECT 1 FROM messages m
           WHERE m.scopeId = thread_summaries.scopeId
             AND m.channelId = thread_summaries.parentChannelId
             AND m.messageId = thread_summaries.parentMessageId)`,
        [scopeId],
      );
    });
  }

  // ---- internals --------------------------------------------------------------

  async function upsertMessageTx(
    tx: WriteTx,
    scopeId: number,
    channelId: string,
    seq: number,
    messageId: string,
    raw: RawRecord,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO messages (scopeId, channelId, seq, messageId, senderType, senderId, sentAt, bodyRaw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scopeId, channelId, seq) DO UPDATE SET
         messageId = excluded.messageId,
         senderType = excluded.senderType,
         senderId = excluded.senderId,
         sentAt = excluded.sentAt,
         bodyRaw = excluded.bodyRaw`,
      [
        scopeId,
        channelId,
        seq,
        messageId,
        typeof raw.senderType === "string" ? raw.senderType : null,
        typeof raw.senderId === "string" ? raw.senderId : null,
        typeof raw.createdAt === "string" ? raw.createdAt : null,
        encodeJson(raw),
      ],
    );
  }

  async function recordRangeTx(tx: WriteTx, scopeId: number, channelId: string, range: Range): Promise<void> {
    const existing = getCoverage(scopeId, channelId);
    const merged = mergeRanges(existing, range);
    await tx.run("DELETE FROM channel_ranges WHERE scopeId = ? AND channelId = ?", [scopeId, channelId]);
    for (const row of merged) {
      await tx.run(
        "INSERT INTO channel_ranges (scopeId, channelId, fromSeq, throughSeq) VALUES (?, ?, ?, ?)",
        [scopeId, channelId, row.fromSeq, row.throughSeq],
      );
    }
  }

  async function writeOverlayTx(
    tx: WriteTx,
    scopeId: number,
    channelId: string,
    seq: number,
    raw: RawRecord,
    effectiveAt: string,
    writeTs: string,
  ): Promise<void> {
    const stored = db.all(
      "SELECT updatedAt FROM message_overlays WHERE scopeId = ? AND channelId = ? AND seq = ?",
      [scopeId, channelId, seq],
    )[0];
    if (stored) {
      const storedUpdatedAt = typeof stored.updatedAt === "string" ? stored.updatedAt : null;
      if (!overlayIsNewer(storedUpdatedAt, effectiveAt)) return;
    }
    await tx.run(
      `INSERT INTO message_overlays (scopeId, channelId, seq, raw, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scopeId, channelId, seq) DO UPDATE SET
         raw = excluded.raw,
         updatedAt = excluded.updatedAt`,
      [scopeId, channelId, seq, encodeJson(raw), writeTs],
    );
  }

  async function writeThreadSummaryTx(
    tx: WriteTx,
    scopeId: number,
    parentChannelId: string,
    parentMessageId: string,
    summary: RawRecord & { threadChannelId?: string },
    ts: string,
  ): Promise<void> {
    await tx.run(
      `INSERT INTO thread_summaries (scopeId, parentChannelId, parentMessageId, raw, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scopeId, parentChannelId, parentMessageId) DO UPDATE SET
         raw = excluded.raw,
         updatedAt = excluded.updatedAt`,
      [scopeId, parentChannelId, parentMessageId, encodeJson(summary), ts],
    );
    if (typeof summary.threadChannelId === "string" && summary.threadChannelId) {
      await tx.run(
        `INSERT INTO thread_links (scopeId, parentChannelId, parentMessageId, threadChannelId)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (scopeId, threadChannelId) DO UPDATE SET
           parentChannelId = excluded.parentChannelId,
           parentMessageId = excluded.parentMessageId`,
        [scopeId, parentChannelId, parentMessageId, summary.threadChannelId],
      );
    }
  }

  /** Cascade delete a channel plus every thread channel hanging under it. */
  async function deleteChannelTx(tx: WriteTx, scopeId: number, channelId: string): Promise<void> {
    const threadChannels = db.all(
      "SELECT threadChannelId FROM thread_links WHERE scopeId = ? AND parentChannelId = ?",
      [scopeId, channelId],
    );
    const channelIds = [channelId, ...threadChannels.map((row) => String(row.threadChannelId))];
    for (const id of channelIds) {
      await tx.run("DELETE FROM messages WHERE scopeId = ? AND channelId = ?", [scopeId, id]);
      await tx.run("DELETE FROM channel_ranges WHERE scopeId = ? AND channelId = ?", [scopeId, id]);
      await tx.run("DELETE FROM overlay_pages WHERE scopeId = ? AND channelId = ?", [scopeId, id]);
      await tx.run("DELETE FROM message_overlays WHERE scopeId = ? AND channelId = ?", [scopeId, id]);
      await tx.run("DELETE FROM read_states WHERE scopeId = ? AND channelId = ?", [scopeId, id]);
    }
    await tx.run("DELETE FROM thread_summaries WHERE scopeId = ? AND parentChannelId = ?", [scopeId, channelId]);
    await tx.run(
      "DELETE FROM thread_links WHERE scopeId = ? AND (parentChannelId = ? OR threadChannelId = ?)",
      [scopeId, channelId, channelId],
    );
    await tx.run("DELETE FROM channels WHERE scopeId = ? AND channelId = ?", [scopeId, channelId]);
  }

  return {
    bootId,
    // Async contract surface (shared CacheRepo): sync results wrapped in
    // resolved promises — IndexedDB-shaped, zero behavioral difference.
    openScope: async (origin: string, userId: string, serverId: string) => openScope(origin, userId, serverId),
    wipeScope,
    wipeAll,
    getChannels: async (scopeId: number, types?: readonly string[]) => getChannels(scopeId, types),
    putChannels,
    getCoverage: async (scopeId: number, channelId: string) => getCoverage(scopeId, channelId),
    getLatestMessages: async (scopeId: number, channelId: string, limit: number) =>
      getLatestMessages(scopeId, channelId, limit),
    appendPage,
    appendLiveMessage,
    applyOverlayPage,
    getOverlayPageInfo: async (scopeId: number, channelId: string, fromSeq: number) =>
      getOverlayPageInfo(scopeId, channelId, fromSeq),
    invalidateOverlayPageMarks,
    applyMessageUpdated,
    applyThreadSummary,
    getThreadSummaries: async (scopeId: number, parentChannelId: string) =>
      getThreadSummaries(scopeId, parentChannelId),
    applyTaskEvent,
    deleteTask,
    getTaskRows: async (scopeId: number) => getTaskRows(scopeId),
    applyReadState,
    getReadStates: async (scopeId: number) => getReadStates(scopeId),
    getInboxPage: async (scopeId: number, pageNo: number) => getInboxPage(scopeId, pageNo),
    putInboxPage,
    getKv: async (scopeId: number, key: string) => getKv(scopeId, key),
    putKv,
    deleteChannel,
    pruneMessages,
    // Sync reads (mobile-only extension): the cold-start first-paint seed
    // path renders before any await boundary; the shared contract is async
    // (Firstmate ruling, desktop-data-cache task #6) and these are the
    // synchronous originals it wraps.
    openScopeSync: openScope,
    getChannelsSync: getChannels,
    getCoverageSync: getCoverage,
    getLatestMessagesSync: getLatestMessages,
    getOverlayPageInfoSync: getOverlayPageInfo,
    getThreadSummariesSync: getThreadSummaries,
    getTaskRowsSync: getTaskRows,
    getReadStatesSync: getReadStates,
    getInboxPageSync: getInboxPage,
    getKvSync: getKv,
  };
}

export type CacheRepo = ReturnType<typeof createCacheRepo>;
export type MobileCacheRepo = CacheRepo;
