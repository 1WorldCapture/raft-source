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

  const attach = (userId: string, serverId: string): void => {
    // Serialize: a rapid identity/server switch must not interleave two
    // openScope+persist pairs.
    chain = chain
      .then(async () => {
        await runtime.attach(origin, userId, serverId);
        attachedUserId = userId;
        try {
          storage.setItem(WEB_CACHE_LAST_SCOPE_KEY, JSON.stringify({ userId, serverId }));
        } catch {
          // Best-effort persistence — the attach itself still worked.
        }
      })
      .catch(() => {
        // A failed attach leaves the previous scope active.
      });
  };

  const sync = (): void => {
    const storeUserId = auth.getState().user?.id ?? null;
    const storeServerId = server.getState().current?.id ?? null;
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
    if (storeServerId === null) return; // wait for the server restore/load
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
  const runtime = await initWebCache();
  // Lazy: authStore/serverStore evaluate browser globals at module scope.
  const [{ useAuthStore }, { useServerStore }, { setActiveCacheProvider }] = await Promise.all([
    import("../store/authStore"),
    import("../store/serverStore"),
    import("./messageCache"),
  ]);
  setActiveCacheProvider(() =>
    runtime.scopeId === null ? null : { repo: runtime.repo, scopeId: runtime.scopeId },
  );
  const auth = useAuthStore as unknown as AuthLike;
  wipeOnExplicitLogout(runtime, auth);
  wireWebCacheLifecycle(runtime, auth, useServerStore as unknown as ServerLike);
  return runtime;
}
