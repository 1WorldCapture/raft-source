import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import {
  backupLastScope,
  backupOfflineUser,
  getBackupLastScope,
  getBackupOfflineUser,
  identityBackupHasData,
  loadIdentityBackup,
  resetIdentityBackupMemory,
} from "../src/cache/identityBackup";

/**
 * Behavior (desktop-data-cache task #12): the offline-session identity is
 * dual-written into global (scopeId 0) kv rows of the cache database, which
 * survived every observed localStorage write-loss incident. Reads are
 * best-effort: a missing database degrades every getter to null.
 */

function freshDb() {
  indexedDB = new IDBFactory() as unknown as IDBFactory & typeof indexedDB;
}

/** Create raft-web-cache with its kv store, like the runtime's schema upgrade. */
async function createCacheDb(seed: Array<{ scopeId: number; key: string; value: unknown }>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("raft-web-cache", 2);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("kv", { keyPath: ["scopeId", "key"] });
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

afterEach(() => {
  resetIdentityBackupMemory();
  freshDb();
});

test("no cache database: load degrades to empty getters, hasData false", async () => {
  freshDb();
  await loadIdentityBackup();
  assert.equal(identityBackupHasData(), false);
  assert.equal(getBackupOfflineUser(), null);
  assert.equal(getBackupLastScope(), null);
});

test("seeded backup rows are loaded into memory once per boot", async () => {
  await createCacheDb([
    { scopeId: 0, key: "identity:offlineUser", value: { id: "u1", email: "a@b.c", name: "anna", emailVerified: true } },
    { scopeId: 0, key: "identity:lastScope", value: { userId: "u1", serverId: "s1" } },
  ]);
  await loadIdentityBackup();
  assert.equal(identityBackupHasData(), true);
  const user = getBackupOfflineUser() as { id?: string };
  assert.equal(user.id, "u1");
  assert.deepEqual(getBackupLastScope(), { userId: "u1", serverId: "s1" });
});

test("backup writes persist rows readable on the next boot", async () => {
  await createCacheDb([]);
  await loadIdentityBackup();
  backupOfflineUser({ id: "u2", email: "x@y.z", name: "bob", emailVerified: true });
  backupLastScope({ userId: "u2", serverId: "s2" });
  assert.deepEqual(getBackupLastScope(), { userId: "u2", serverId: "s2" });
  // Simulate next boot: fresh memory, same database.
  resetIdentityBackupMemory();
  await loadIdentityBackup();
  const user = getBackupOfflineUser() as { id?: string };
  assert.equal(user.id, "u2");
  assert.deepEqual(getBackupLastScope(), { userId: "u2", serverId: "s2" });
});

test("scoped kv rows never leak into the identity backup", async () => {
  await createCacheDb([{ scopeId: 7, key: "identity:offlineUser", value: { id: "u-other" } }]);
  await loadIdentityBackup();
  assert.equal(identityBackupHasData(), false);
  assert.equal(getBackupOfflineUser(), null);
});
