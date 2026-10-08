import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, StaleRequestError } from "../api/client";
import { seedConversations } from "../cache/boot";
import { pruneToHistoryLimit, reconcileAfterChannelRefresh } from "../cache/cacheCleanup";
import { getCacheRuntime } from "../cache/runtime";
import { useT } from "../i18n/provider";
import { parseChannelUnread, parseChannels } from "../model/messages";
import { useSession } from "../state/session";
import type { RaftServer } from "../model/messages";
import { useRaftStore } from "../state/store";
import { serversFromCacheValue } from "./serverRailCache";
import { setCurrentServerRole } from "./serverRole";
import { useServerRailStore } from "./serverRailStore";
import { useServerRail } from "./useServerRail";

// Directory bumps (socket catch-up, a live message for a never-listed channel)
// coalesce into one full reload behind this delay.
const DIRECTORY_REFRESH_DEBOUNCE_MS = 1500;

// Module-level ticket shared by every tab mounting this hook: whichever page
// mounted first drives the load; a later mount's stale ticket aborts its own
// callbacks silently, so concurrent tab mounts never race the store writes.
let directoryLoadTicket = 0;

export type DirectoryState = {
  loading: boolean;
  error: string | null;
  reload: () => void;
  switchServerAndReload: (server: RaftServer) => void;
};

/**
 * Loads and refreshes the conversation directory (channels + DMs + unread)
 * for the current server — the full pipeline previously owned by the retired
 * home tab: cold-start cache fast path, rail seed, history pruning, network
 * load, and the directory-bump debounce. Shared by the PM / DMs / channels
 * tab roots.
 */
export function useDirectory(): DirectoryState {
  const session = useSession();
  const t = useT();
  const { switchServer, loadServers } = useServerRail();
  const directoryVersion = useRaftStore((state) => state.directoryVersion);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const directoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => () => {
    if (directoryTimer.current) clearTimeout(directoryTimer.current);
  }, []);

  const loadDirectory = useCallback(async (serverId: string, ticket: number) => {
    const [channelData, dmData, unreadData] = await Promise.all([
      session.client.get<unknown>("/channels?archived=exclude"),
      session.client.get<unknown>("/channels/dm"),
      session.client.get<unknown>("/channels/unread?summary=1"),
    ]);
    if (ticket !== directoryLoadTicket) return;
    const channels = parseChannels(channelData).filter((channel) => channel.type !== "dm");
    const dms = parseChannels(dmData).map((channel) => ({ ...channel, type: channel.type || "dm" }));
    useRaftStore.getState().setChannelUnread(parseChannelUnread(unreadData));
    useRaftStore.getState().setConversations([...channels, ...dms]);
    // Persist the directory to the local cache (#client-data-cache task #2):
    // two type-scoped batches so dropMissing never crosses lists (#4).
    // AWAITED in order: fire-and-forget writes let the reconcile's own
    // db.write open while a putChannels transaction is still running —
    // sqlite rejects the nested transaction and the delete silently dies.
    try {
      const runtime = getCacheRuntime();
      const scope = runtime.scopeFor(serverId);
      if (scope === null) return;
      await runtime.repo.putChannels(scope, channels.map((channel) => ({
        id: channel.id,
        type: channel.type || "channel",
        lastMessageAt: channel.lastMessageAt ?? null,
        raw: channel as unknown as Record<string, unknown>,
      })));
      await runtime.repo.putChannels(scope, dms.map((channel) => ({
        id: channel.id,
        type: "dm",
        lastMessageAt: channel.lastMessageAt ?? null,
        raw: channel as unknown as Record<string, unknown>,
      })));
      await runtime.repo.putKv(scope, "channelUnread", parseChannelUnread(unreadData) as unknown as Record<string, unknown>);
      // Channel reconcile (#client-data-cache task #4): both lists are in
      // hand here — Promise.all above means /channels AND /channels/dm both
      // succeeded (any throw skips this block entirely). stillActive drops
      // the sweep when the identity was wiped mid-flight (logout / origin
      // change makes scopeFor return a different id).
      await reconcileAfterChannelRefresh(
        runtime.repo,
        scope,
        async () => ({
          channels: channels.map((channel) => ({ id: channel.id, archivedAt: channel.archivedAt })),
          dms: dms.map((channel) => ({ id: channel.id, archivedAt: channel.archivedAt })),
        }),
        { stillActive: () => runtime.scopeFor(serverId) === scope },
      );
    } catch {
      // Cache unavailable — directory still works from the network.
    }
  }, [session.client]);

  const loadFor = useCallback(async (preferredId: string | null) => {
    const ticket = ++directoryLoadTicket;
    setError(null);
    // Cold-start fast path (#client-data-cache task #2): paint the cached
    // directory BEFORE any network call — offline cold starts still show the
    // conversation list. Only seeds an empty store; the network response
    // below overwrites without flicker.
    try {
      const runtime = getCacheRuntime();
      const seedServerId = preferredId ?? sessionRef.current.serverId ?? "";
      // Child effects run before the provider's attach effect on cold start,
      // so attach here first (idempotent) — otherwise scopeFor is null.
      if (runtime.scopeId === null && sessionRef.current.origin && sessionRef.current.user && seedServerId) {
        runtime.attach(sessionRef.current.origin, sessionRef.current.user.id, seedServerId);
      }
      const scope = runtime.scopeFor(seedServerId);
      if (scope !== null && useRaftStore.getState().conversations.length === 0) {
        const seeded = seedConversations(runtime.repo.getChannelsSync(scope));
        if (seeded.length > 0) useRaftStore.getState().setConversations(seeded);
        const cachedUnread = runtime.repo.getKvSync(scope, "channelUnread");
        if (cachedUnread) useRaftStore.getState().setChannelUnread(cachedUnread as unknown as Record<string, { unreadCount: number; hasMention: boolean }>);
      }
      // Server-rail seed (#desktop-data-cache task #1): same fast path for the
      // rail and the header title — an offline cold start paints the cached
      // server list; the loadServers call below overwrites it wholesale (and
      // drops removed servers) once the network answers.
      if (scope !== null && useServerRailStore.getState().servers.length === 0) {
        const servers = serversFromCacheValue(runtime.repo.getKv(scope, "serverList"));
        if (servers.length > 0) useServerRailStore.setState({ servers });
      }
    } catch {
      // Cache unavailable or not yet initialized.
    }
    try {
      // The rail store's own ticket drops a stale switch's server/badge
      // writes; this hook's ticket guards the directory below.
      const result = await loadServers(sessionRef.current.client, preferredId);
      if (ticket !== directoryLoadTicket) return;
      if (result.stale) return;
      const selected = result.server;
      if (!selected) {
        useRaftStore.getState().setConversations([]);
        return;
      }
      setCurrentServerRole(selected.role ?? null);
      // History prune: GET /servers now carries the server's authoritative
      // messageHistoryDays (falls back to the plan table on older servers).
      // Idempotent DELETE — safe on every load.
      try {
        const runtime = getCacheRuntime();
        const pruneScope = runtime.scopeFor(selected.id);
        if (pruneScope !== null) await pruneToHistoryLimit(runtime.repo, pruneScope, selected);
      } catch {
        // Cache unavailable — the server-side limit still applies.
      }
      // Use the id this load was given, not a serverId closed over from an earlier render.
      const activeId = preferredId ?? sessionRef.current.serverId;
      if (selected.id !== activeId) await sessionRef.current.selectServer(selected.id);
      await loadDirectory(selected.id, ticket);
    } catch (caught) {
      if (ticket !== directoryLoadTicket || caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : tRef.current("mobile.channels.loadFailed"));
    } finally {
      if (ticket === directoryLoadTicket) {
        setLoading(false);
      }
    }
  }, [loadDirectory, loadServers]);

  const loadForRef = useRef(loadFor);
  loadForRef.current = loadFor;

  // Initial load and server switches load immediately. Tab focus does NOT
  // reload: realtime events keep the list fresh and pull-to-refresh is the
  // explicit escape hatch (task #2/#6).
  useEffect(() => {
    if (!session.ready || !session.origin) return;
    void loadFor(session.serverId);
  }, [loadFor, session.origin, session.ready, session.serverId]);

  // Directory bumps reload the list after a debounce, so a burst of bumps
  // (catch-up after reconnect, several new conversations at once) coalesces.
  const seenDirectoryVersion = useRef(directoryVersion);
  useEffect(() => {
    if (seenDirectoryVersion.current === directoryVersion) return;
    seenDirectoryVersion.current = directoryVersion;
    if (!sessionRef.current.ready || !sessionRef.current.origin) return;
    if (directoryTimer.current) clearTimeout(directoryTimer.current);
    directoryTimer.current = setTimeout(() => {
      directoryTimer.current = null;
      void loadForRef.current(sessionRef.current.serverId);
    }, DIRECTORY_REFRESH_DEBOUNCE_MS);
  }, [directoryVersion]);

  const reload = useCallback(() => {
    void loadForRef.current(sessionRef.current.serverId);
  }, []);

  // Server switch from the PM tab's rail: clear the directory in place (the
  // new server's list paints from its own load) and reload. Mirrors the
  // retired home tab's selectServer behaviour.
  const switchServerAndReload = useCallback((server: RaftServer) => {
    setLoading(true);
    setError(null);
    useRaftStore.getState().setConversations([]);
    void switchServer(server).then(() => loadForRef.current(server.id));
  }, [switchServer]);

  return { loading, error, reload, switchServerAndReload };
}
