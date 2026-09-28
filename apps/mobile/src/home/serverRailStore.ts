// Shared server-rail state (task #1, #mobile-server-rail).
//
// The rail lives on every tab now, so the server list (already returned by
// GET /servers in the user's switcher order), the cross-server unread dots
// and the badge refresh live here instead of inside the home screen. Loads
// carry a ticket: a rapid A→B switch drops A's late responses instead of
// restoring A's badges on top of B's session.
import { create } from "zustand";
import { activityUnreadByServer } from "../activity/model";
import { getCacheRuntime } from "../cache/runtime";
import { isRecord, parseServers, parseUnreadSummary, type RaftServer } from "../model/messages";

/** Minimal client surface the store needs (session.client satisfies it). */
export interface ServerRailClient {
  get: (path: string, options?: { server?: boolean }) => Promise<unknown>;
  patch: (path: string, body?: unknown, options?: { server?: boolean }) => Promise<unknown>;
}

/**
 * Reorder servers by stored switcher ids: known ids first in stored order
 * (duplicates dropped), any servers missing from the stored list appended in
 * their current order. Mirrors the web serverStore's updateServerOrder logic.
 */
export function orderServersByStoredIds(servers: RaftServer[], storedIds: ReadonlyArray<string>): RaftServer[] {
  const byId = new Map(servers.map((server) => [server.id, server]));
  const seen = new Set<string>();
  const ordered: RaftServer[] = [];
  for (const id of storedIds) {
    const server = byId.get(id);
    if (!server || seen.has(id)) continue;
    seen.add(id);
    ordered.push(server);
  }
  for (const server of servers) {
    if (!seen.has(server.id)) ordered.push(server);
  }
  return ordered;
}

/** loadServers result: `stale` (a newer load owns the state — callers must do nothing) vs. a real answer. */
export interface LoadServersResult {
  stale: boolean;
  server: RaftServer | null;
}

/**
 * Persist the ordered server list to the local cache (#desktop-data-cache
 * task #1) so an offline cold start can paint the rail and title. The list is
 * origin+user data, but the kv store is scope-partitioned (per server), so the
 * same snapshot is written under every member server's scope — whichever
 * server a cold start lands on finds it. Best-effort: no runtime / no scope
 * yet (child effects run before the session attach) or a failed write just
 * means the next successful load retries.
 */
function persistServersToCache(servers: readonly RaftServer[]): void {
  void (async () => {
    try {
      const runtime = getCacheRuntime();
      for (const server of servers) {
        const scope = runtime.scopeFor(server.id);
        if (scope === null) continue;
        await runtime.repo.putKv(scope, "serverList", { servers: servers as unknown as Record<string, unknown>[] });
      }
    } catch {
      // Cache unavailable — the rail works from the network.
    }
  })();
}

/**
 * Optimistically lower a server's Activity badge after local reads (Activity
 * page markRead/markAllRead): clamped at 0, never creates a key, never turns a
 * positive count negative. The next summary refresh lands the server truth.
 */
export function adjustActivityUnread(
  activityUnread: Readonly<Record<string, number>>,
  serverId: string,
  readCount: number,
): Readonly<Record<string, number>> {
  const current = activityUnread[serverId];
  if (readCount <= 0 || current === undefined || current <= 0) return activityUnread;
  return { ...activityUnread, [serverId]: Math.max(0, current - readCount) };
}

interface ServerRailState {
  servers: RaftServer[];
  serverUnread: Record<string, number>;
  activityUnread: Record<string, number>;
  /** Bumped by loadServers; responses from an earlier ticket are dropped. */
  loadTicket: number;
  /** Separate ticket for badge refreshes — a badge refresh must never invalidate an in-flight load (and vice versa, a load supersedes older badge responses). */
  badgeTicket: number;
  /** Fetch the ordered server list + unread summary. */
  loadServers: (client: ServerRailClient, preferredId: string | null) => Promise<LoadServersResult>;
  /** Refresh only the unread summary (tab focus, return from background). */
  refreshBadges: (client: ServerRailClient) => Promise<void>;
  /** Apply a `server_order:updated` payload (own optimistic reorder or another client's). */
  applyServerOrder: (serverIds: unknown) => void;
  /**
   * Drag-and-drop reorder (task #4): apply the new order optimistically, then
   * persist it; on failure roll back to the previous order and return false.
   * The server's confirmation (and the echo of our own socket event) is
   * idempotent through orderServersByStoredIds.
   */
  reorderServers: (client: ServerRailClient, orderedIds: ReadonlyArray<string>) => Promise<boolean>;
  reset: () => void;
}

export const useServerRailStore = create<ServerRailState>((set, get) => ({
  servers: [],
  serverUnread: {},
  activityUnread: {},
  loadTicket: 0,
  badgeTicket: 0,

  loadServers: async (client, preferredId) => {
    const ticket = get().loadTicket + 1;
    // Also supersede any badge response still in flight, so it cannot
    // overwrite the fresher full-load data below — strictly greater than the
    // current badgeTicket, which may already outrun the load ticket.
    set({ loadTicket: ticket, badgeTicket: get().badgeTicket + 1 });
    const [serverData, unreadData] = await Promise.all([
      client.get("/servers", { server: false }),
      client.get("/servers/unread-summary", { server: false }),
    ]);
    if (get().loadTicket !== ticket) return { stale: true, server: null };
    const next = parseServers(serverData);
    set({
      servers: next,
      serverUnread: parseUnreadSummary(unreadData),
      activityUnread: activityUnreadByServer(unreadData),
    });
    persistServersToCache(next);
    return { stale: false, server: next.find((server) => server.id === preferredId) ?? next[0] ?? null };
  },

  refreshBadges: async (client) => {
    // Only the badge ticket moves: a badge refresh must not invalidate an
    // in-flight loadServers (that would blank the home list on cold start).
    const ticket = get().badgeTicket + 1;
    set({ badgeTicket: ticket });
    const data = await client.get("/servers/unread-summary", { server: false });
    if (get().badgeTicket !== ticket) return;
    set({
      serverUnread: parseUnreadSummary(data),
      activityUnread: activityUnreadByServer(data),
    });
  },

  applyServerOrder: (serverIds) => {
    if (!Array.isArray(serverIds)) return;
    const ids = serverIds.filter((id): id is string => typeof id === "string");
    set((state) => ({ servers: orderServersByStoredIds(state.servers, ids) }));
    persistServersToCache(get().servers);
  },

  reorderServers: async (client, orderedIds) => {
    const previous = get().servers;
    const next = orderServersByStoredIds(previous, orderedIds);
    set({ servers: next });
    try {
      const data = await client.patch("/servers/order", { serverOrder: next.map((server) => server.id) }, { server: false });
      if (isRecord(data) && Array.isArray(data.serverOrder)) {
        const saved = data.serverOrder.filter((id): id is string => typeof id === "string");
        set((state) => ({ servers: orderServersByStoredIds(state.servers, saved) }));
      }
      persistServersToCache(get().servers);
      return true;
    } catch {
      set({ servers: previous });
      return false;
    }
  },

  reset: () => set({ servers: [], serverUnread: {}, activityUnread: {}, loadTicket: 0, badgeTicket: 0 }),
}));
