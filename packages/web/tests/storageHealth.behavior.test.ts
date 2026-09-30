import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  runStorageHealthCheck,
  shouldWipeLocalStorage,
  touchStorageCanary,
  WEB_STORAGE_CANARY_KEY,
} from "../src/cache/storageHealth";

/**
 * Behavior (desktop-data-cache task #12): a boot-time canary detects the
 * hard-kill localStorage write-loss loop. Wipe only when the canary written
 * by the previous boot is GONE while the IndexedDB cache clearly holds
 * identity data — first runs, cleared site data, and the boot right after a
 * wipe must never trigger.
 */

type MemStorage = { map: Map<string, string> };
function memStorage(initial: Record<string, string> = {}): MemStorage & {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const REAL_WINDOW = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (REAL_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = REAL_WINDOW;
});

test("decision matrix: wipe only on canary-lost + cache-has-identity + not just-wiped", () => {
  assert.equal(shouldWipeLocalStorage({ canaryPresent: false, cacheHasIdentity: true, justWiped: false }), true);
  assert.equal(shouldWipeLocalStorage({ canaryPresent: false, cacheHasIdentity: false, justWiped: false }), false);
  assert.equal(shouldWipeLocalStorage({ canaryPresent: true, cacheHasIdentity: true, justWiped: false }), false);
  assert.equal(shouldWipeLocalStorage({ canaryPresent: false, cacheHasIdentity: true, justWiped: true }), false);
});

test("touchStorageCanary writes the key the next boot reads; storage failures are swallowed", () => {
  const s = memStorage();
  touchStorageCanary(s);
  assert.ok(s.map.has(WEB_STORAGE_CANARY_KEY));
  touchStorageCanary({ setItem: () => { throw new Error("quota"); } });
});

test("healthy boot keeps the canary and never asks the bridge to reset", async () => {
  const s = memStorage({ [WEB_STORAGE_CANARY_KEY]: "1" });
  const bridge = { justWiped: async () => false, resetAndRelaunch: () => { throw new Error("must not reset"); } };
  (globalThis as { window?: unknown }).window = { raftDesktop: { storage: bridge } };
  const result = await runStorageHealthCheck({ storage: s, cacheHasIdentity: true });
  assert.equal(result, "healthy");
  assert.ok(s.map.has(WEB_STORAGE_CANARY_KEY));
});

test("corrupted boot (canary lost, cache has identity) asks the desktop bridge to wipe and relaunch", async () => {
  const s = memStorage(); // no canary
  let resets = 0;
  const bridge = { justWiped: async () => false, resetAndRelaunch: () => { resets += 1; } };
  (globalThis as { window?: unknown }).window = { raftDesktop: { storage: bridge } };
  const result = await runStorageHealthCheck({ storage: s, cacheHasIdentity: true });
  assert.equal(result, "wipe-requested");
  assert.equal(resets, 1);
  assert.equal(s.map.has(WEB_STORAGE_CANARY_KEY), false, "no canary refresh while relaunching");
});

test("the boot after a wipe (justWiped) skips the heuristic and starts a fresh canary", async () => {
  const s = memStorage();
  const bridge = { justWiped: async () => true, resetAndRelaunch: () => { throw new Error("must not reset"); } };
  (globalThis as { window?: unknown }).window = { raftDesktop: { storage: bridge } };
  const result = await runStorageHealthCheck({ storage: s, cacheHasIdentity: true });
  assert.equal(result, "healthy");
  assert.ok(s.map.has(WEB_STORAGE_CANARY_KEY));
});

test("browser (no bridge): corruption is reported, not wiped, canary refreshed", async () => {
  delete (globalThis as { window?: unknown }).window;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: string) => void errors.push(String(msg));
  try {
    const s = memStorage();
    const result = await runStorageHealthCheck({ storage: s, cacheHasIdentity: true });
    assert.equal(result, "healthy");
    assert.equal(s.map.has(WEB_STORAGE_CANARY_KEY), true);
    assert.equal(errors.length, 1);
  } finally {
    console.error = origError;
  }
});
