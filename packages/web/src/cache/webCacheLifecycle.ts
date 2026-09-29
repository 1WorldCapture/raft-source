// Web cache lifecycle wiring (desktop-data-cache task #7 / P1).
//
// Deliberately separate from webCache.ts: that module (runtime + repos) stays
// free of store imports so node tests can construct it without localStorage;
// this module glues the runtime onto the auth/server stores. Store modules
// are imported LAZILY (authStore reads localStorage at module scope) and
// tests inject fakes directly. Plan red line: wiring subscribes from the
// outside — no store file is edited.
//
// Lifecycle rules (review ruling e3c588fe):
//   startup (user still null — /me pending or offline)  →  NEVER wipe; attach
//     the LAST persisted identity (ids only, not credentials) so the first
//     paint — offline included — can read the cache;
//   login / server restore                               →  attach (switch
//     scopes without wiping; a DIFFERENT userId wipes first — an account
//     switch must not leak the previous account's data);
//   session expiry (user cleared by a 401, not a logout) →  keep the cache;
//   explicit logout (the authStore logout action)        →  resetAll(). The
//     wipe rides the wrapped action, NOT a "user became null" observation —
//     null is ambiguous during startup.

import { RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";
import { forgetOfflineUser } from "../utils/offlineSession";
import { beginDirectoryAttachWait, noteDirectoryAttachSettled, noteDirectorySessionUser } from "./directoryCache";
import { beginActiveCacheBoot, noteActiveCacheSettled, setActiveCacheProvider } from "./messageCache";
import { initWebCache } from "./webCache";
import type { WebCacheRuntime } from "./webCache";

export type AuthLike = {
  getState(): { user: { id: string } | null; logout: (trigger?: string) => void };
  subscribe(listener: (state: { user: { id: string } | null }, prev: { user: { id: string } | null }) => void): () => void;
  setState(partial: { logout: (trigger?: string) => void }): void;
};

export type ServerLike = {
  getState(): { current: { id: string } | null };
  subscribe(listener: (state: { current: { id: string } | null }, prev: { current: { id: string } | null }) => void): () => void;
};

export type ScopeIdentityStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** localStorage key for the last attached identity — ids only, never tokens. */
export const WEB_CACHE_LAST_SCOPE_KEY = "raft_web_cache_last_scope";

type PersistedScope = { userId: string; serverId: string };

function readPersisted(storage: ScopeIdentityStorage): PersistedScope | null {
  try {
    const raw = storage.getItem(WEB_CACHE_LAST_SCOPE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: unknown; serverId?: unknown };
    if (typeof parsed.userId === "string" && typeof parsed.serverId === "string" && parsed.userId && parsed.serverId) {
      return { userId: parsed.userId, serverId: parsed.serverId };
    }
    return null;
  } catch {
    return null;
  }
}

export type WireDeps = {
  storage?: ScopeIdentityStorage;
};

export function wireWebCacheLifecycle(
  runtime: WebCacheRuntime,
  auth: AuthLike,
  server: ServerLike,
  deps: WireDeps = {},
): { unsubscribe(): void } {
  const origin = RUNTIME_API_BASE;
  const storage: ScopeIdentityStorage = deps.storage ?? (globalThis as { localStorage?: ScopeIdentityStorage }).localStorage!;
  /** The userId of the last completed attach this wiring observed. */
  let attachedUserId: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let attachWave = 0;

  const attach = (userId: string, serverId: string): void => {
    // Serialize: a rapid identity/server switch must not interleave two
    // openScope+persist pairs. Arm the directory wait synchronously, before
    // runtime.attach nulls the holder, so a load started in this turn waits
    // for the new scope instead of missing the seed and the write-back.
    const wave = ++attachWave;
    const alreadyAttached = runtime.scopeId !== null
      && runtime.serverId === serverId
      && runtime.userId === userId;
    if (!alreadyAttached) beginDirectoryAttachWait();
    // An attach queued before a logout wipe belongs to the logged-out session.
    const resetEpoch = runtime.resetEpoch;
    chain = chain
      .then(async () => {
        try {
          if (runtime.resetEpoch !== resetEpoch) return;
          await runtime.attach(origin, userId, serverId);
          // Persist only an attach that was adopted: one superseded by a
          // logout wipe must not write the identity back.
          if (runtime.scopeId === null || runtime.userId !== userId || runtime.serverId !== serverId) return;
          attachedUserId = userId;
          try {
            storage.setItem(WEB_CACHE_LAST_SCOPE_KEY, JSON.stringify({ userId, serverId }));
          } catch {
            // Best-effort persistence — the attach itself still worked.
          }
        } finally {
          if (wave === attachWave) noteDirectoryAttachSettled();
        }
      })
      .catch(() => {
        // A failed attach (openScope error) leaves the holder DETACHED until
        // the next attach — never a stale scope: the generation was already
        // bumped and the old scopeId nulled at attach entry, so consumers
        // see "no cache" rather than the previous identity's data. This is
        // deliberate (review item 4): a degraded no-cache window beats
        // reading/writing the wrong server's scope.
        if (wave === attachWave) noteDirectoryAttachSettled();
      });
  };

  const sync = (): void => {
    const storeUserId = auth.getState().user?.id ?? null;
    const storeServerId = server.getState().current?.id ?? null;
    noteDirectorySessionUser(storeUserId);
    if (storeUserId === null) {
      // Startup before /me, an offline boot, or a 401 session clear — never
      // a wipe (that rides the wrapped logout action). Attach the persisted
      // identity so the cold first paint can read the cache.
      const persisted = readPersisted(storage);
      if (persisted && runtime.scopeId === null) {
        attach(persisted.userId, storeServerId ?? persisted.serverId);
      }
      return;
    }
    if (storeServerId === null) {
      // /me (or offline admission) can win the race against this wiring's
      // first sync. current stays null until the cached server list seeds,
      // and that list lives in the persisted scope — returning here without
      // attaching it leaves the cold start on "create your first server".
      const persisted = readPersisted(storage);
      if (persisted && persisted.userId === storeUserId && runtime.scopeId === null) {
        attach(persisted.userId, persisted.serverId);
      }
      return;
    }
    if (attachedUserId !== null && attachedUserId !== storeUserId) {
      // Account switch without a logout in between: the previous account's
      // cached data must not survive into the new session.
      chain = chain.then(async () => {
        await runtime.resetAll();
        try {
          storage.removeItem(WEB_CACHE_LAST_SCOPE_KEY);
        } catch {
          // ignore
        }
        attachedUserId = null;
      });
    }
    attach(storeUserId, storeServerId);
  };

  const unsubscribeAuth = auth.subscribe((state, prev) => {
    if ((prev.user?.id ?? null) !== (state.user?.id ?? null)) sync();
  });
  const unsubscribeServer = server.subscribe((state, prev) => {
    if ((prev.current?.id ?? null) !== (state.current?.id ?? null)) sync();
  });
  sync();
  // The boot gate (#17) waits for this first attach attempt, including the
  // case where there is nothing to attach yet.
  void chain.then(() => {
    noteActiveCacheSettled();
  });
  return {
    unsubscribe() {
      unsubscribeAuth();
      unsubscribeServer();
    },
  };
}

/**
 * Ride the explicit logout action with the cache wipe. Observing "user
 * became null" cannot distinguish logout from the startup null or a 401
 * session clear, so the wipe is bound to the action itself (an external
 * wrapper; no store file is touched).
 */
export function wipeOnExplicitLogout(runtime: WebCacheRuntime, auth: AuthLike, deps: WireDeps = {}): void {
  const storage: ScopeIdentityStorage = deps.storage ?? (globalThis as { localStorage?: ScopeIdentityStorage }).localStorage!;
  const original = auth.getState().logout;
  if (typeof original !== "function") return;
  auth.setState({
    logout: (trigger?: string) => {
      // Same wrapper as the scope id: explicit logout drops the public
      // profile snapshot (#17). 401 session expiry does not come through here.
      forgetOfflineUser(storage);
      // Drop the persisted identity BEFORE the original action clears the
      // user: that user→null transition runs the lifecycle sync, which would
      // otherwise read this id and re-attach (re-creating the scope row and
      // re-persisting the id) right after the wipe.
      try {
        storage.removeItem(WEB_CACHE_LAST_SCOPE_KEY);
      } catch {
        // ignore
      }
      void runtime.resetAll().then(() => {
        try {
          storage.removeItem(WEB_CACHE_LAST_SCOPE_KEY);
        } catch {
          // ignore
        }
      });
      return original(trigger);
    },
  });
}

/**
 * App bootstrap (main.tsx): create the runtime singleton, wire the real
 * stores, and hand #9's message-cache bridge its live holder — the provider
 * is evaluated on every access, so server switches and logout flow through
 * without this module owning any of that lifecycle.
 */
export async function bootWebCache(): Promise<WebCacheRuntime> {
  // Arm before IndexedDB open so a channel load during boot waits for attach
  // instead of painting an empty pane and never looking at the cache.
  beginActiveCacheBoot();
  try {
    const runtime = await initWebCache();
    // Lazy: authStore/serverStore evaluate browser globals at module scope.
    const [{ useAuthStore }, { useServerStore }] = await Promise.all([
      import("../store/authStore"),
      import("../store/serverStore"),
    ]);
    setActiveCacheProvider(() =>
      runtime.scopeId === null
        ? null
        : {
            repo: runtime.repo,
            scopeId: runtime.scopeId,
            serverId: runtime.serverId,
            userId: runtime.userId,
            generation: runtime.generation,
          },
    );
    const auth = useAuthStore as unknown as AuthLike;
    wipeOnExplicitLogout(runtime, auth);
    wireWebCacheLifecycle(runtime, auth, useServerStore as unknown as ServerLike);
    return runtime;
  } catch (error) {
    noteActiveCacheSettled();
    throw error;
  }
}
