// Web cache lifecycle wiring (desktop-data-cache task #7 / P1).
//
// Deliberately separate from webCache.ts: that module (runtime + repos) stays
// free of store imports so node tests can construct it without localStorage;
// this module glues the runtime onto the auth/server stores. The store
// modules are imported LAZILY — authStore reads localStorage at module scope,
// which node tests do not have — and tests inject fake stores directly.
// Plan red line: wiring subscribes from the outside — no store rework.
//
//   login + current server → attach(origin, userId, serverId)
//   server switch          → attach the new scope (no wiping)
//   logout                 → resetAll() — the whole database goes

import { RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";
import { initWebCache } from "./webCache";
import type { WebCacheRuntime } from "./webCache";

export type AuthLike = {
  getState(): { user: { id: string } | null };
  subscribe(listener: (state: { user: { id: string } | null }, prev: { user: { id: string } | null }) => void): () => void;
};

export type ServerLike = {
  getState(): { current: { id: string } | null };
  subscribe(listener: (state: { current: { id: string } | null }, prev: { current: { id: string } | null }) => void): () => void;
};

/**
 * Subscribe the cache lifecycle to the auth and server stores:
 * - user signed in + current server → attach that server's scope;
 * - current server changed → attach the new scope (data of other servers
 *   stays — switching never wipes);
 * - user signed out → resetAll() (logout/origin change clears everything).
 */
export function wireWebCacheLifecycle(runtime: WebCacheRuntime, auth: AuthLike, server: ServerLike): () => void {
  const origin = RUNTIME_API_BASE;
  const sync = (): void => {
    const userId = auth.getState().user?.id ?? null;
    const serverId = server.getState().current?.id ?? null;
    if (userId === null) {
      void runtime.resetAll();
      return;
    }
    if (serverId !== null) void runtime.attach(origin, userId, serverId);
  };
  const unsubscribeAuth = auth.subscribe((state, prev) => {
    if ((prev.user?.id ?? null) !== (state.user?.id ?? null)) sync();
  });
  const unsubscribeServer = server.subscribe((state, prev) => {
    if ((prev.current?.id ?? null) !== (state.current?.id ?? null)) sync();
  });
  sync();
  return () => {
    unsubscribeAuth();
    unsubscribeServer();
  };
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
  wireWebCacheLifecycle(
    runtime,
    useAuthStore as unknown as AuthLike,
    useServerStore as unknown as ServerLike,
  );
  return runtime;
}
