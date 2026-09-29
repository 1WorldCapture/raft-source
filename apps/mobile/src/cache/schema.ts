// Cache schema (client-data-cache task #1, approved draft 2026-09-28).
//
// Versioning: PRAGMA user_version carries the schema version. A fresh file
// starts at 0 and gets created; an existing file with a DIFFERENT version is
// dropped and rebuilt — no migrations (Firstmate-approved decision: cache is
// disposable by design, correctness comes from the server).
//
// Partitioning: one scopes row per (origin, userId, serverId); every table
// carries scopeId. This matches the app's existing invalidation semantics
// where switching server or logging out clears all data anyway.

import type { SqliteDb } from "./port";

// v2 (desktop-data-cache task #8): message_overlays.updatedAt now holds the
// server updatedAt watermark instead of the local write time. The version
// bump drops and rebuilds the cache (first launch after upgrade refetches).
export const CACHE_SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  userId TEXT NOT NULL,
  serverId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (origin, userId, serverId)
);

CREATE TABLE IF NOT EXISTS channels (
  scopeId INTEGER NOT NULL,
  channelId TEXT NOT NULL,
  type TEXT NOT NULL,
  lastMessageAt TEXT,
  raw TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (scopeId, channelId)
);

CREATE TABLE IF NOT EXISTS messages (
  scopeId INTEGER NOT NULL,
  channelId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  messageId TEXT NOT NULL,
  senderType TEXT,
  senderId TEXT,
  sentAt TEXT,
  bodyRaw TEXT NOT NULL,
  PRIMARY KEY (scopeId, channelId, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_by_id
  ON messages (scopeId, channelId, messageId);

CREATE TABLE IF NOT EXISTS channel_ranges (
  scopeId INTEGER NOT NULL,
  channelId TEXT NOT NULL,
  fromSeq INTEGER NOT NULL,
  throughSeq INTEGER NOT NULL,
  PRIMARY KEY (scopeId, channelId, fromSeq),
  CHECK (fromSeq <= throughSeq)
);

CREATE TABLE IF NOT EXISTS overlay_pages (
  scopeId INTEGER NOT NULL,
  channelId TEXT NOT NULL,
  fromSeq INTEGER NOT NULL,
  throughSeq INTEGER NOT NULL,
  refreshedAt TEXT NOT NULL,
  bootId TEXT NOT NULL,
  PRIMARY KEY (scopeId, channelId, fromSeq)
);

CREATE TABLE IF NOT EXISTS message_overlays (
  scopeId INTEGER NOT NULL,
  channelId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  raw TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (scopeId, channelId, seq)
);

CREATE TABLE IF NOT EXISTS thread_summaries (
  scopeId INTEGER NOT NULL,
  parentChannelId TEXT NOT NULL,
  parentMessageId TEXT NOT NULL,
  raw TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (scopeId, parentChannelId, parentMessageId)
);

CREATE TABLE IF NOT EXISTS thread_links (
  scopeId INTEGER NOT NULL,
  parentChannelId TEXT NOT NULL,
  parentMessageId TEXT NOT NULL,
  threadChannelId TEXT NOT NULL,
  PRIMARY KEY (scopeId, threadChannelId)
);
CREATE INDEX IF NOT EXISTS thread_links_by_parent
  ON thread_links (scopeId, parentChannelId);

CREATE TABLE IF NOT EXISTS task_rows (
  scopeId INTEGER NOT NULL,
  taskId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  raw TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (scopeId, taskId)
);

CREATE TABLE IF NOT EXISTS read_states (
  scopeId INTEGER NOT NULL,
  channelId TEXT NOT NULL,
  maxReadSeq INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scopeId, channelId)
);

CREATE TABLE IF NOT EXISTS inbox_pages (
  scopeId INTEGER NOT NULL,
  pageNo INTEGER NOT NULL,
  raw TEXT NOT NULL,
  fetchedAt TEXT NOT NULL,
  PRIMARY KEY (scopeId, pageNo)
);

CREATE TABLE IF NOT EXISTS kv (
  scopeId INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scopeId, key)
);
`;

export function ensureSchema(db: SqliteDb): void {
  const row = db.all("PRAGMA user_version");
  const current = Number(row[0]?.user_version ?? 0);
  if (current === CACHE_SCHEMA_VERSION) return;
  if (current !== 0) {
    // Incompatible version: the cache is disposable — drop EVERY user table
    // (not just the ones we know) and rebuild from scratch.
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((row2) => String(row2.name));
    for (const table of tables) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  }
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION}`);
}
