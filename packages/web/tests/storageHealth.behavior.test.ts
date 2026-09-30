import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  CANARY_RECORD_DELAY_MS,
  nextSessionId,
  parseCanaryValue,
  runStorageHealthCheck,
  shouldWipeLocalStorage,
  touchStorageCanary,
  WEB_STORAGE_CANARY_KEY,
} from "../src/cache/storageHealth";

/**
 * Behavior (desktop-data-cache task #12, review item 1): the canary compares
 * SESSION VALUES, not key existence — a profile that already ran this build
 * keeps an OLD canary value while every newer write is dropped, and key
 * existence alone would never detect that. Direction matters: a session that
 * died before its delayed durable record leaves localStorage NEWER than the
 * backup, which is healthy and must never wipe.
 */

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const REAL_WINDOW = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (REAL_WINDOW === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = REAL_WINDOW;
});

test("decision matrix: wipe only when the canary is strictly older than the durable backup", () => {
  // corruption: last session's writes dropped, localStorage still shows the previous id
  assert.equal(shouldWipeLocalStorage({ canaryValue: 4, backupSessionId: 5, justWiped: false }), true);
  // everything dropped including the old canary
  assert.equal(shouldWipeLocalStorage({ canaryValue: null, backupSessionId: 5, justWiped: false }), true);
  // healthy: localStorage is current
  assert.equal(shouldWipeLocalStorage({ canaryValue: 5, backupSessionId: 5, justWiped: false }), false);
  // healthy: session died before its delayed durable record (review case)
  assert.equal(shouldWipeLocalStorage({ canaryValue: 6, backupSessionId: 5, justWiped: false }), false);
  // no durable record yet: fresh profile, right after logout, or early after upgrading
  assert.equal(shouldWipeLocalStorage({ canaryValue: null, backupSessionId: null, justWiped: false }), false);
  assert.equal(shouldWipeLocalStorage({ canaryValue: null, backupSessionId: 3, justWiped: true }), false);
});

test("parseCanaryValue accepts non-negative integers and rejects garbage", () => {
  assert.equal(parseCanaryValue("7"), 7);
  assert.equal(parseCanaryValue("0"), 0);
  assert.equal(parseCanaryValue(null), null);
  assert.equal(parseCanaryValue("abc"), null);
  assert.equal(parseCanaryValue("-3"), null);
});

test("nextSessionId adopts the newer of the two copies, +1", () => {
  assert.equal(nextSessionId(5, 5), 6);
  assert.equal(nextSessionId(null, 9), 10);
  assert.equal(nextSessionId(11, 4), 12);
  assert.equal(nextSessionId(null, null), 0);
});

test("healthy boot adopts and writes this session's id and records it only after the delay", async () => {
  const s = memStorage({ [WEB_STORAGE_CANARY_KEY]: "5" });
  const recorded: number[] = [];
  const bridge = { justWiped: async () => false, resetAndRelaunch: () => { throw new Error("must not reset"); } };
  (globalThis as { window?: unknown }).window = { raftDesktop: { storage: bridge } };
  const result = await runStorageHealthCheck({
    storage: s,
    backupSessionId: 5,
    recordBackupSessionId: (id) => void recorded.push(id),
    recordDelayMs: 30,
  });
  assert.equal(result, "healthy");
  assert.equal(s.map.get(WEB_STORAGE_CANARY_KEY), "6");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(recorded, [6]);
});

test("corrupted boot (canary older than backup) asks the desktop bridge to wipe and relaunch", async () => {
  const s = memStorage({ [WEB_STORAGE_CANARY_KEY]: "4" }); // backup says 5
  let resets = 0;
  const bridge = { justWiped: async () => false, resetAndRelaunch: () => { resets += 1; } };
  (globalThis as { window?: unknown }).window = { raftDesktop: { storage: bridge } };
  const result = await runStorageHealthCheck({ storage: s, backupSessionId: 5, recordDelayMs: 30 });
  assert.equal(result, "wipe-requested");
  assert.equal(resets, 1);
  assert.equal(s.map.has(WEB_STORAGE_CANARY_KEY), true, "canary refreshed for the relaunch boot");
});

test("the boot after a wipe (justWiped) skips the heuristic and starts a fresh session", async () => {
  const s = memStorage();
  const bridge = { justWiped: async () => true, resetAndRelaunch: () => { throw new Error("must not reset"); } };
  (globalThis as { window?: unknown }).window = { raftDesktop: { storage: bridge } };
  const result = await runStorageHealthCheck({ storage: s, backupSessionId: 5, recordDelayMs: 30 });
  assert.equal(result, "healthy");
  assert.ok(s.map.has(WEB_STORAGE_CANARY_KEY));
});

test("browser (no bridge): corruption is reported, not wiped, session still adopted", async () => {
  delete (globalThis as { window?: unknown }).window;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (msg: string) => void errors.push(String(msg));
  try {
    const s = memStorage({ [WEB_STORAGE_CANARY_KEY]: "4" });
    const result = await runStorageHealthCheck({ storage: s, backupSessionId: 5, recordDelayMs: 30 });
    assert.equal(result, "healthy");
    assert.ok(s.map.has(WEB_STORAGE_CANARY_KEY));
    assert.equal(errors.length, 1);
  } finally {
    console.error = origError;
  }
});

test("touchStorageCanary rewrites the CURRENT session id (login keeps canary adjacent to tokens)", async () => {
  const s = memStorage({ [WEB_STORAGE_CANARY_KEY]: "5" });
  (globalThis as { window?: unknown }).window = { raftDesktop: { storage: { justWiped: async () => false } } };
  await runStorageHealthCheck({ storage: s, backupSessionId: 5, recordDelayMs: CANARY_RECORD_DELAY_MS });
  const later = memStorage(Object.fromEntries(s.map)); // simulate a second context reading the same storage
  later.map.set(WEB_STORAGE_CANARY_KEY, "stale-from-tear");
  touchStorageCanary(later);
  assert.equal(later.map.get(WEB_STORAGE_CANARY_KEY), "6");
});
