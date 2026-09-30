import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  backupLastScope,
  backupOfflineUser,
  getBackupLastScope,
  getBackupOfflineUser,
  getBackupSessionId,
  loadIdentityBackup,
  recordBackupSessionId,
  resetIdentityBackupMemory,
} from "../src/cache/identityBackup";
import { WEB_CACHE_DB_NAME, WEB_CACHE_SCHEMA_VERSION } from "../src/cache/idbRepo";

/**
 * Behavior (desktop-data-cache task #12, review items 1/2/5): the identity
 * backup lives in global (scopeId 0) kv rows of the cache database, which
 * survived every observed localStorage write-loss incident. The backup's
 * own connection must never block a later schema upgrade of that database,
 * and a logout must stand down writes still in flight so the logged-out
 * account's rows cannot land after the wipe.
 */

function freshDb() {
  indexedDB = new IDBFactory() as unknown as IDBFactory & typeof indexedDB;
}

/** Create raft-web-cache with its kv store, like the runtime's schema upgrade. */
async function createCacheDb(seed: Array<{ scopeId: number; key: string; value: unknown }>, version = WEB_CACHE_SCHEMA_VERSION): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(WEB_CACHE_DB_NAME, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("kv")) {
        req.result.createObjectStore("kv", { keyPath: ["scopeId", "key"] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction("kv", "readwrite");
    for (const row of seed) tx.objectStore("kv").put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

function readRows(): Promise<Array<{ scopeId: number; key: string; value: unknown }>> {
  return new Promise((resolve) => {
    const req = indexedDB.open(WEB_CACHE_DB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      const out: Array<{ scopeId: number; key: string; value: unknown }> = [];
      const cur = db.transaction("kv").objectStore("kv").openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          db.close();
          resolve(out);
          return;
        }
        out.push(c.value as { scopeId: number; key: string; value: unknown });
        c.continue();
      };
    };
  });
}

afterEach(() => {
  resetIdentityBackupMemory();
  freshDb();
});

test("no cache database: load degrades to empty getters", async () => {
  freshDb();
  await loadIdentityBackup();
  assert.equal(getBackupOfflineUser(), null);
  assert.equal(getBackupLastScope(), null);
  assert.equal(getBackupSessionId(), null);
});

test("seeded backup rows (identity + session id) are loaded into memory once per boot", async () => {
  await createCacheDb([
    { scopeId: 0, key: "identity:offlineUser", value: { id: "u1", email: "a@b.c", name: "anna", emailVerified: true } },
    { scopeId: 0, key: "identity:lastScope", value: { userId: "u1", serverId: "s1" } },
    { scopeId: 0, key: "identity:canarySession", value: 5 },
  ]);
  await loadIdentityBackup();
  assert.equal((getBackupOfflineUser() as { id?: string }).id, "u1");
  assert.deepEqual(getBackupLastScope(), { userId: "u1", serverId: "s1" });
  assert.equal(getBackupSessionId(), 5);
});

test("backup writes persist rows readable on the next boot, session id included", async () => {
  await createCacheDb([]);
  await loadIdentityBackup();
  backupOfflineUser({ id: "u2", email: "x@y.z", name: "bob", emailVerified: true });
  backupLastScope({ userId: "u2", serverId: "s2" });
  recordBackupSessionId(9);
  // Let the fire-and-forget writes commit, then simulate the next boot.
  await new Promise((r) => setTimeout(r, 30));
  resetIdentityBackupMemory();
  await loadIdentityBackup();
  assert.equal((getBackupOfflineUser() as { id?: string }).id, "u2");
  assert.deepEqual(getBackupLastScope(), { userId: "u2", serverId: "s2" });
  assert.equal(getBackupSessionId(), 9);
});

test("scoped kv rows never leak into the identity backup", async () => {
  await createCacheDb([{ scopeId: 7, key: "identity:offlineUser", value: { id: "u-other" } }]);
  await loadIdentityBackup();
  assert.equal(getBackupOfflineUser(), null);
  assert.equal(getBackupSessionId(), null);
});

test("review item 2: the backup connection closes on versionchange and never blocks an upgrade", async () => {
  await createCacheDb([{ scopeId: 0, key: "identity:canarySession", value: 1 }], 2);
  await loadIdentityBackup();
  // Keep a live backup connection, then upgrade the database to v3 with a new
  // store — with a pinned connection this would hang/blocked-timeout.
  backupOfflineUser({ id: "u3", email: "c@d.e", name: "carol", emailVerified: true });
  await new Promise((r) => setTimeout(r, 20));
  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(WEB_CACHE_DB_NAME, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("future_store")) {
        req.result.createObjectStore("future_store");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("upgrade blocked by the backup connection"));
    setTimeout(() => reject(new Error("upgrade timed out")), 2000);
  });
  upgraded.close();
  // The next backup access re-attaches on the new version.
  await loadIdentityBackup();
  assert.equal(getBackupSessionId(), 1);
});

test("review item 5: a logout stands down writes still in flight (no residue of the logged-out account)", async () => {
  await createCacheDb([]);
  await loadIdentityBackup();
  // Start a write, then log out before it commits: fake a slow commit by
  // resetting right after backupOfflineUser fires (the write resolves after).
  backupOfflineUser({ id: "u-out", email: "o@p.q", name: "olaf", emailVerified: true });
  resetIdentityBackupMemory(); // the logout wrapper's synchronous stand-down
  await new Promise((r) => setTimeout(r, 30));
  const rows = await readRows();
  const residue = rows.some((row) => row.scopeId === 0 && row.key === "identity:offlineUser");
  assert.equal(residue, false, "in-flight write must not land after the wipe");
});
