// Identity backup rows in the IndexedDB cache (desktop-data-cache task #12).
//
// The offline-session identity (public user snapshot + last cache scope) is
// persisted in localStorage — which can enter the hard-kill write-loss loop.
// The cache database (IndexedDB) survived every observed incident, so both
// records are ALSO written here, under global (scopeId 0) kv rows. Reads are
// best-effort fallbacks: localStorage stays the primary copy, and the
// explicit-logout wipe (resetAll, which clears every store in this database)
// removes these rows with everything else.
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
const KEY_SESSION_ID = "identity:canarySession";

type KvRow = { scopeId: number; key: string; value: unknown };

type BackupMemory = {
  offlineUser: unknown;
  lastScope: unknown;
  sessionId: number | null;
};

let memory: BackupMemory | null = null;
let dbHandle: IDBDatabase | null = null;
let opening: Promise<IDBDatabase | null> | null = null;
// Bumped synchronously by the explicit-logout wrapper. Any backup write that
// has not committed yet stands down, so a wipe can never be followed by a
// late write of the logged-out account's rows (review item 5).
let logoutEpoch = 0;

function openCacheDb(): Promise<IDBDatabase | null> {
  if (dbHandle) return Promise.resolve(dbHandle);
  if (opening) return opening;
  opening = (async () => {
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
      req.onsuccess = () => {
        const db = req.result;
        // A connection pinned to an old version would block every future
        // schema upgrade of the cache database (openGuarded then falls back
        // to the memory repo on every boot). Close on versionchange so the
        // upgrade proceeds; the next backup access re-attaches (review item 2).
        db.onversionchange = () => {
          if (dbHandle === db) {
            dbHandle = null;
            opening = null;
          }
          db.close();
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  })();
  // Cache only a SUCCESSFUL attach: the boot-time load often runs before the
  // runtime has created the database, and caching that null would silently
  // disable every later backup write for the whole session.
  void opening.then((db) => {
    if (db) dbHandle = db;
    opening = null;
  });
  return opening;
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
  const epoch = logoutEpoch;
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
    return;
  }
  // A logout wiped the database while this write was in flight: the row just
  // landed in a freshly re-created store and must not survive as residue of
  // the logged-out account. Remove it again.
  if (epoch !== logoutEpoch) {
    try {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").delete([GLOBAL_SCOPE_ID, key]);
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      // ignore
    }
  }
}

/**
 * Load the backup rows into memory once per boot. Safe to call multiple
 * times (idempotent); failures degrade every getter to null.
 */
export async function loadIdentityBackup(): Promise<void> {
  const [offlineUser, lastScope, sessionId] = await Promise.all([
    readKv(KEY_OFFLINE_USER),
    readKv(KEY_LAST_SCOPE),
    readKv(KEY_SESSION_ID),
  ]);
  if (memory === null) {
    memory = {
      offlineUser,
      lastScope,
      sessionId: typeof sessionId === "number" && Number.isFinite(sessionId) ? sessionId : null,
    };
  }
}

/** The last session id whose canary was still provably durable — see storageHealth. */
export function getBackupSessionId(): number | null {
  return memory?.sessionId ?? null;
}

export function recordBackupSessionId(sessionId: number): void {
  if (memory === null) memory = { offlineUser: null, lastScope: null, sessionId: null };
  memory.sessionId = sessionId;
  void writeKv(KEY_SESSION_ID, sessionId);
}

export function backupOfflineUser(user: UserLike): void {
  if (memory === null) memory = { offlineUser: null, lastScope: null, sessionId: null };
  memory.offlineUser = user;
  void writeKv(KEY_OFFLINE_USER, user);
}

export function backupLastScope(scope: ScopeIdentity): void {
  if (memory === null) memory = { offlineUser: null, lastScope: null, sessionId: null };
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

/**
 * Drop the in-memory copies and stand down in-flight writes (the logout
 * wrapper calls this in the same synchronous window as the localStorage key
 * removal). The database itself is cleared by resetAll.
 */
export function resetIdentityBackupMemory(): void {
  logoutEpoch += 1;
  memory = null;
  if (dbHandle) {
    try {
      dbHandle.close();
    } catch {
      // already closed
    }
    dbHandle = null;
  }
  opening = null;
}
