// Web cache runtime + lifecycle (desktop-data-cache task #7 / P1).
//
// Owns the IndexedDB repo instance and maps it onto the app's session
// semantics, mirroring the mobile runtime (apps/mobile/src/cache/runtime.ts):
//
//   login + server selected  →  attach(origin, userId, serverId)  (openScope,
//                               switch scope without wiping)
//   server switch            →  attach(...) again — per-server scopes
//   logout / origin change   →  resetAll() — the whole database goes
//
// Degradation: when IndexedDB is unavailable (privacy mode, old Safari, open
// failures like quota) the runtime degrades to a no-op repo — reads return
// empty, writes are discarded, the app keeps working from the network.
//
// Wiring is deliberately OUTSIDE the stores (plan red line: no store-internals
// rework) — initWebCacheLifecycle() subscribes to authStore/serverStore.

import type { CacheRepo } from "@botiverse/raft-shared/src/cacheRepoContract.ts";
import { createIdbCacheRepo } from "./idbRepo";
import { createWebCacheRepo } from "./webCacheRepo";

export type WebCacheRuntime = {
  readonly repo: CacheRepo;
  /** False when IndexedDB was unavailable and the no-op repo is in place. */
  readonly available: boolean;
  /** The attached scope id, or null while detached (logged out). */
  readonly scopeId: number | null;
  /** The attached scope's serverId, or null while detached/transitioning. */
  readonly serverId: string | null;
  /** The attached scope's userId, or null while detached/transitioning. */
  readonly userId: string | null;
  /**
   * Monotonic invalidation era (P2c review; Firstmate naming ruling:
   * "generation" — directoryCache already has a store-level serverEpoch).
   * Bumped SYNCHRONOUSLY at the entry of every identity-changing
   * attach()/resetAll(), before any await. Long-running writers (task-board
   * snapshot write-back) capture {scopeId, generation} and re-verify before
   * each write, so a logout wipe or a server switch invalidates in-flight
   * writes immediately instead of after the await. Re-attaching the SAME
   * identity returns early WITHOUT bumping (a cold-start repeat attach must
   * not blank the holder under a concurrent MainLayout load).
   */
  readonly generation: number;
  attach(origin: string, userId: string, serverId: string): Promise<number>;
  resetAll(): Promise<void>;
  /**
   * Fires after every attach/resetAll (and once at subscribe time) with the
   * current scopeId — consumers like #9's messageCache bridge use it to
   * refresh their active-cache holder without owning any lifecycle.
   */
  subscribe(listener: (scopeId: number | null) => void): () => void;
};

export async function createWebCacheRuntime(
  deps: { now?: () => string; repo?: CacheRepo } = {},
): Promise<WebCacheRuntime> {
  let repo: CacheRepo;
  let available = true;
  if (deps.repo) {
    // Test injection: skip IndexedDB entirely.
    repo = deps.repo;
  } else {
    try {
      repo = await createIdbCacheRepo(deps);
    } catch {
      // Privacy mode / quota / missing IndexedDB: fall back to #9's in-memory
      // repo — the session keeps cache semantics in RAM (lost on reload).
      repo = createWebCacheRepo(deps.now ? { now: deps.now } : {});
      available = false;
    }
  }
  let scopeId: number | null = null;
  let generation = 0;
  let lastResetGeneration = 0;
  let attachedServerId: string | null = null;
  let attachedIdentity: { origin: string; userId: string; serverId: string } | null = null;
  const listeners = new Set<(scopeId: number | null) => void>();
  const emit = (): void => {
    for (const listener of listeners) listener(scopeId);
  };
  return {
    repo,
    get available() {
      return available;
    },
    get scopeId() {
      return scopeId;
    },
    get serverId() {
      return attachedServerId;
    },
    get userId() {
      return scopeId === null ? null : attachedIdentity?.userId ?? null;
    },
    get generation() {
      return generation;
    },
    async attach(origin, userId, serverId) {
      if (scopeId !== null && attachedIdentity?.origin === origin
        && attachedIdentity.userId === userId && attachedIdentity.serverId === serverId) {
        // Identical identity re-attach: the live scope is already the right
        // one — return it without invalidating the era (a cold-start repeat
        // attach must not blank the holder under a concurrent load).
        return scopeId;
      }
      // Invalidate the previous era SYNCHRONOUSLY: between this bump and the
      // openScope completion the holder reports no scope at all, so neither
      // a stale read (seeding the new server from the old cache) nor a
      // stale write (the old server's rows landing in the new scope) can
      // slip through the transition window.
      generation += 1;
      const era = generation;
      scopeId = null;
      attachedServerId = null;
      const nextScopeId = await repo.openScope(origin, userId, serverId);
      // A resetAll() may have raced this attach; only adopt the scope when
      // this attach is still the newest era.
      if (generation === era) {
        scopeId = nextScopeId;
        attachedServerId = serverId;
        attachedIdentity = { origin, userId, serverId };
      } else if (lastResetGeneration > era && scopeId === null) {
        // Superseded by a wipe (logout) with nothing attached since: openScope
        // re-created the scope row after wipeAll. Drop it again so a logout
        // leaves no identity behind (desktop-data-cache acceptance ③).
        await repo.wipeScope(nextScopeId);
      }
      emit();
      return nextScopeId;
    },
    async resetAll() {
      generation += 1;
      lastResetGeneration = generation;
      scopeId = null;
      attachedServerId = null;
      attachedIdentity = null;
      await repo.wipeAll();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(scopeId);
      return () => listeners.delete(listener);
    },
  };
}

let singleton: WebCacheRuntime | null = null;
let initPromise: Promise<WebCacheRuntime> | null = null;

/** App bootstrap entry (main.tsx): creates the runtime singleton. */
export function initWebCache(): Promise<WebCacheRuntime> {
  if (singleton) return Promise.resolve(singleton);
  initPromise ??= createWebCacheRuntime().then((runtime) => {
    singleton = runtime;
    return runtime;
  });
  return initPromise;
}

/** The app-wide runtime; null before initWebCache resolves. */
export function getWebCacheRuntime(): WebCacheRuntime | null {
  return singleton;
}

