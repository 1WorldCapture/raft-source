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

export type WebCacheRuntime = {
  readonly repo: CacheRepo;
  /** False when IndexedDB was unavailable and the no-op repo is in place. */
  readonly available: boolean;
  /** The attached scope id, or null while detached (logged out). */
  readonly scopeId: number | null;
  attach(origin: string, userId: string, serverId: string): Promise<number>;
  resetAll(): Promise<void>;
  /**
   * Fires after every attach/resetAll (and once at subscribe time) with the
   * current scopeId — consumers like #9's messageCache bridge use it to
   * refresh their active-cache holder without owning any lifecycle.
   */
  subscribe(listener: (scopeId: number | null) => void): () => void;
};

export async function createWebCacheRuntime(deps: { now?: () => string } = {}): Promise<WebCacheRuntime> {
  let repo: CacheRepo;
  let available = true;
  try {
    repo = await createIdbCacheRepo(deps);
  } catch {
    repo = createNoopCacheRepo();
    available = false;
  }
  let scopeId: number | null = null;
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
    async attach(origin, userId, serverId) {
      scopeId = await repo.openScope(origin, userId, serverId);
      emit();
      return scopeId;
    },
    async resetAll() {
      await repo.wipeAll();
      scopeId = null;
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

/** Inert repo for degraded environments: empty reads, discarded writes. */
export function createNoopCacheRepo(): CacheRepo {
  const bootId = `noop-${Math.random().toString(36).slice(2)}`;
  const empty = async (): Promise<void> => {};
  return {
    bootId,
    openScope: async () => 0,
    wipeScope: empty,
    wipeAll: empty,
    getChannels: async () => [],
    putChannels: empty,
    deleteChannel: empty,
    getCoverage: async () => [],
    getLatestMessages: async () => [],
    appendPage: empty,
    appendLiveMessage: empty,
    pruneMessages: empty,
    applyOverlayPage: empty,
    getOverlayPageInfo: async () => null,
    invalidateOverlayPageMarks: empty,
    applyMessageUpdated: empty,
    applyThreadSummary: empty,
    getThreadSummaries: async () => ({}),
    applyTaskEvent: empty,
    deleteTask: empty,
    getTaskRows: async () => [],
    applyReadState: empty,
    getReadStates: async () => ({}),
    getInboxPage: async () => null,
    putInboxPage: empty,
    getKv: async () => null,
    putKv: empty,
  };
}
