// Cache runtime singleton (client-data-cache task #2, shared with #3).
//
// The one place the app (and Anna's cacheSync write-through in #3) obtains
// the cache repository. Owns the lifecycle mapping onto session semantics:
//
//   login / server selected  →  attach(origin, userId, serverId)  (sync,
//                               bootstrap-only write; cold-start first paint
//                               then reads synchronously)
//   selectServer             →  attach(...) again, same origin/user, NO wipe
//                               (each server's cache lives in its own scope)
//   logout                   →  wipeScope(current)  (task #4 contract)
//   origin change            →  wipeAll()  (draft decision: whole DB goes)
//
// This module deliberately imports NO adapter: the app bootstrap injects the
// expo-sqlite opener via initCacheRuntime, so node tests can construct the
// runtime against node:sqlite without dragging react-native into the import
// graph. The repo itself never talks to the network.

import type { SqliteDb } from "./port";
import { createCacheRepo, type CacheRepo } from "./repo";

export type CacheRuntimeDeps = {
  openDb: () => SqliteDb;
  now?: () => string;
};

export type CacheRuntime = {
  readonly repo: CacheRepo;
  /** Currently attached scope id, or null when detached. */
  readonly scopeId: number | null;
  /**
   * Attach (or switch to) a scope. Synchronous by design: it is a
   * bootstrap-time idempotent insert, and cold-start first paint needs the
   * scope id before any await boundary. Remembers the identity so callers
   * can scope other servers (e.g. during a server switch) via scopeFor.
   */
  attach(origin: string, userId: string, serverId: string): number;
  /**
   * Scope id for another server under the attached identity — null before
   * the first attach. Never creates bogus partitions with empty keys.
   */
  scopeFor(serverId: string): number | null;
  /** Logout: wipe the attached account+server partition, then detach. */
  logout(): Promise<void>;
  /** Origin change: the whole local DB is disposable. */
  resetAll(): Promise<void>;
};

export function createCacheRuntime(deps: CacheRuntimeDeps): CacheRuntime {
  const repo = createCacheRepo({ db: deps.openDb(), now: deps.now });
  let scopeId: number | null = null;
  let identity: { origin: string; userId: string } | null = null;
  return {
    repo,
    get scopeId() {
      return scopeId;
    },
    attach(origin, userId, serverId) {
      identity = { origin, userId };
      scopeId = repo.openScope(origin, userId, serverId);
      return scopeId;
    },
    scopeFor(serverId) {
      if (identity === null || !serverId) return null;
      return repo.openScope(identity.origin, identity.userId, serverId);
    },
    async logout() {
      if (scopeId !== null) await repo.wipeScope(scopeId);
      scopeId = null;
      identity = null;
    },
    async resetAll() {
      await repo.wipeAll();
      scopeId = null;
      identity = null;
    },
  };
}

let singleton: CacheRuntime | null = null;

/**
 * App bootstrap entry: call once (session layer) with the platform db
 * opener, e.g. () => openExpoSqliteDb("raft-cache.sqlite").
 */
export function initCacheRuntime(deps: CacheRuntimeDeps): CacheRuntime {
  singleton = createCacheRuntime(deps);
  return singleton;
}

/** The app-wide instance. Throws when used before initCacheRuntime. */
export function getCacheRuntime(): CacheRuntime {
  if (singleton === null) throw new Error("cache runtime not initialized");
  return singleton;
}

/** Test hook: drop the singleton so a fresh init can build another. */
export function __resetCacheRuntimeSingleton(): void {
  singleton = null;
}

// ---- sync cancellation seam (review fix #3) --------------------------------
//
// The session layer must cancel in-flight sync/write-through BEFORE wiping
// the DB on logout/origin change, or late responses write data back into a
// cleared cache. #3's wiring registers its canceller here; the session calls
// cancelCacheSync() at the top of logout/origin-change. No-op when nothing
// is registered (e.g. #3 not wired yet, tests).

type CancelFn = () => void;

let registeredCancel: CancelFn | null = null;

/** #3's sync runner registers its canceller; null unregisters. */
export function registerCacheSyncCancel(fn: CancelFn | null): void {
  registeredCancel = fn;
}

/** Cancel any registered in-flight cache sync/write-through (best-effort). */
export function cancelCacheSync(): void {
  try {
    registeredCancel?.();
  } catch {
    // Cancellation must never block logout.
  }
}
