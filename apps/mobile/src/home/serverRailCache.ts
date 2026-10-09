// Server-rail cache helpers (#desktop-data-cache task #1). The ordered server
// list is persisted under the kv key "serverList" (one snapshot per member
// server's scope — see serverRailStore.persistServersToCache). These pure
// helpers turn a cached value back into rail-renderable state.
import { getCacheRuntime } from "../cache/runtime";
import { isRecord, parseServers, type RaftServer } from "../model/messages";
import { setCurrentServerRole } from "./serverRole";
import { markServerRailResolved } from "./serverRailReady";
import { useServerRailStore } from "./serverRailStore";

/** Validate a cached `serverList` kv value into servers; junk degrades to []. */
export function serversFromCacheValue(value: unknown): RaftServer[] {
  if (!isRecord(value) || !Array.isArray(value.servers)) return [];
  return parseServers(value.servers);
}

/**
 * Turn a synchronous `serverList` kv read into the rail plus the selected
 * server's role. A Promise (the async `getKv` mistake) is not a record, so
 * it degrades to null instead of painting an empty list.
 */
export function cachedServerRail(
  value: Record<string, unknown> | null,
  serverId: string,
): { servers: RaftServer[]; role: string | null } | null {
  const servers = serversFromCacheValue(value);
  if (servers.length === 0) return null;
  const current = servers.find((server) => server.id === serverId) ?? servers[0] ?? null;
  return { servers, role: current?.role ?? null };
}

let seededKey: string | null = null;

export function resetCachedServerRailSeed(): void {
  seededKey = null;
}

/** Fill an empty rail from the attached scope. No-op when the list is already there. */
export function applyCachedServerRail(serverId: string): boolean {
  if (!serverId || useServerRailStore.getState().servers.length > 0) return false;
  const runtime = getCacheRuntime();
  const scope = runtime.scopeFor(serverId);
  if (scope === null) return false;
  const seeded = cachedServerRail(runtime.repo.getKvSync(scope, "serverList"), serverId);
  if (!seeded) return false;
  useServerRailStore.setState({ servers: seeded.servers });
  setCurrentServerRole(seeded.role);
  markServerRailResolved();
  return true;
}

/**
 * Cold-start first paint: attach the cache scope and seed the rail before
 * children render. Retries the same identity only when the list is still empty
 * so a later successful read (directory effect) can still fill it.
 */
export function seedCachedServerRail(input: {
  ready: boolean;
  origin: string | null;
  userId: string | null;
  serverId: string | null;
}): void {
  if (!input.ready || !input.origin || !input.userId || !input.serverId) return;
  const key = `${input.origin}\n${input.userId}\n${input.serverId}`;
  if (seededKey === key && useServerRailStore.getState().servers.length > 0) return;
  try {
    const runtime = getCacheRuntime();
    if (runtime.scopeId === null) runtime.attach(input.origin, input.userId, input.serverId);
    const filled = applyCachedServerRail(input.serverId);
    if (filled || useServerRailStore.getState().servers.length > 0) seededKey = key;
  } catch {
    seededKey = null;
  }
}
