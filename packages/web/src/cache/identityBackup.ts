// Identity backup rows in the IndexedDB cache (desktop-data-cache task #12).
//
// The offline-session identity (public user snapshot + last cache scope) is
// persisted in localStorage — which can enter the hard-kill write-loss loop.
// The cache database (IndexedDB) survived every observed incident, so both
// records are ALSO written here, under global (scopeId 0) kv rows. Reads are
// best-effort fallbacks: localStorage stays the primary copy, and the
// explicit-logout wipe (resetAll) deletes this database wholesale, so the
// backup dies with everything else on logout.
//
// Tokens are deliberately NOT backed up here — credentials stay in
// localStorage only (moving them is a separate security decision).

import { WEB_CACHE_DB_NAME } from "./idbRepo";
import type { ScopeIdentity } from "../utils/offlineSession";

/** Structural shape of the authStore User — kept local to avoid a cache→store cycle. */
export type UserLike = Record<string, unknown>;

const GLOBAL_SCOPE_ID = 0;
const KEY_OFFLINE_USER = "identity:offlineUser";
const KEY_LAST_SCOPE = "identity:lastScope";

type KvRow = { scopeId: number; key: string; value: unknown };

let memory: { offlineUser: unknown; lastScope: unknown } | null = null;
let opened: Promise<IDBDatabase | null> | null = null;

function openCacheDb(): Promise<IDBDatabase | null> {
  if (opened) return opened;
  opened = (async () => {
    // Never create the database from here: a fresh open would race the
    // runtime's versioned open. Only attach when it already exists.
    try {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === WEB_CACHE_DB_NAME)) return null;
    } catch {
      return null;
    }
    return new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open(WEB_CACHE_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  })();
  return opened;
}

async function readKv(key: string): Promise<unknown> {
  const db = await openCacheDb();
  if (!db) return null;
  try {
    return await new Promise<unknown>((resolve) => {
      const req = db.transaction("kv").objectStore("kv").get([GLOBAL_SCOPE_ID, key]);
      req.onsuccess = () => resolve((req.result as KvRow | undefined)?.value ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeKv(key: string, value: unknown): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({ scopeId: GLOBAL_SCOPE_ID, key, value });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // Best-effort backup; the localStorage copy remains the primary.
  }
}

/**
 * Load both backup rows into memory once per boot. Safe to call multiple
 * times (idempotent); failures degrade every getter to null.
 */
export async function loadIdentityBackup(): Promise<void> {
  const [offlineUser, lastScope] = await Promise.all([
    readKv(KEY_OFFLINE_USER),
    readKv(KEY_LAST_SCOPE),
  ]);
  if (memory === null) memory = { offlineUser, lastScope };
}

/** True when at least one identity row exists — the health check's signal. */
export function identityBackupHasData(): boolean {
  return memory !== null && (memory.offlineUser !== null || memory.lastScope !== null);
}

export function backupOfflineUser(user: UserLike): void {
  if (memory === null) memory = { offlineUser: null, lastScope: null };
  memory.offlineUser = user;
  void writeKv(KEY_OFFLINE_USER, user);
}

export function backupLastScope(scope: ScopeIdentity): void {
  if (memory === null) memory = { offlineUser: null, lastScope: null };
  memory.lastScope = scope;
  void writeKv(KEY_LAST_SCOPE, scope);
}

export function getBackupOfflineUser(): unknown {
  return memory?.offlineUser ?? null;
}

export function getBackupLastScope(): ScopeIdentity | null {
  const raw = memory?.lastScope;
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as { userId?: unknown; serverId?: unknown };
  if (typeof parsed.userId === "string" && parsed.serverId !== undefined && typeof parsed.serverId === "string") {
    return { userId: parsed.userId, serverId: parsed.serverId };
  }
  return null;
}

/** Drop the in-memory copies (logout wipes the database itself via resetAll). */
export function resetIdentityBackupMemory(): void {
  memory = null;
  opened = null;
}
