// Shared server-rail state (task #1, #mobile-server-rail).
//
// The rail lives on every tab now, so the server list (already returned by
// GET /servers in the user's switcher order), the cross-server unread dots
// and the badge refresh live here instead of inside the home screen. Loads
// carry a ticket: a rapid A→B switch drops A's late responses instead of
// restoring A's badges on top of B's session.
import { create } from "zustand";
import { activityUnreadByServer } from "../activity/model";
import { parseServers, parseUnreadSummary, type RaftServer } from "../model/messages";

/** Minimal client surface the store needs (session.client satisfies it). */
export interface ServerRailClient {
  get: (path: string, options?: { server?: boolean }) => Promise<unknown>;
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

interface ServerRailState {
  servers: RaftServer[];
  serverUnread: Record<string, number>;
  activityUnread: Record<string, number>;
  /** Bumped by every load; responses from an earlier ticket are dropped. */
  loadTicket: number;
  /** Fetch the ordered server list + unread summary; null when stale or empty. */
  loadServers: (client: ServerRailClient, preferredId: string | null) => Promise<RaftServer | null>;
  /** Refresh only the unread summary (tab focus, return from background). */
  refreshBadges: (client: ServerRailClient) => Promise<void>;
  /** Apply a `server_order:updated` payload (own optimistic reorder or another client's). */
  applyServerOrder: (serverIds: unknown) => void;
  reset: () => void;
}

export const useServerRailStore = create<ServerRailState>((set, get) => ({
  servers: [],
  serverUnread: {},
  activityUnread: {},
  loadTicket: 0,

  loadServers: async (client, preferredId) => {
    const ticket = get().loadTicket + 1;
    set({ loadTicket: ticket });
    const [serverData, unreadData] = await Promise.all([
      client.get("/servers", { server: false }),
      client.get("/servers/unread-summary", { server: false }),
    ]);
    if (get().loadTicket !== ticket) return null;
    const next = parseServers(serverData);
    set({
      servers: next,
      serverUnread: parseUnreadSummary(unreadData),
      activityUnread: activityUnreadByServer(unreadData),
    });
    return next.find((server) => server.id === preferredId) ?? next[0] ?? null;
  },

  refreshBadges: async (client) => {
    const ticket = get().loadTicket + 1;
    set({ loadTicket: ticket });
    const data = await client.get("/servers/unread-summary", { server: false });
    if (get().loadTicket !== ticket) return;
    set({
      serverUnread: parseUnreadSummary(data),
      activityUnread: activityUnreadByServer(data),
    });
  },

  applyServerOrder: (serverIds) => {
    if (!Array.isArray(serverIds)) return;
    const ids = serverIds.filter((id): id is string => typeof id === "string");
    set((state) => ({ servers: orderServersByStoredIds(state.servers, ids) }));
  },

  reset: () => set({ servers: [], serverUnread: {}, activityUnread: {}, loadTicket: 0 }),
}));
