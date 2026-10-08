import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { closeChoosePm } from "./choosePm";
import { setCurrentServerRole } from "./serverRole";
import { useServerRailStore } from "./serverRailStore";
import { useSession } from "../state/session";
import type { RaftServer } from "../model/messages";

// Shared rail binding for any tab (task #1, #mobile-server-rail): the server
// list, cross-server unread dots and switching live in useServerRailStore;
// screens keep owning their own per-server data reloads off session.serverId.
export function useServerRail() {
  const session = useSession();
  const servers = useServerRailStore((state) => state.servers);
  const serverUnread = useServerRailStore((state) => state.serverUnread);
  const activityUnread = useServerRailStore((state) => state.activityUnread);
  const loadServers = useServerRailStore((state) => state.loadServers);
  const refreshBadges = useServerRailStore((state) => state.refreshBadges);
  const current = servers.find((server) => server.id === session.serverId) ?? null;

  // Switching from any tab only applies the session change; every screen
  // (home directory, tasks board, members list) reloads on serverId change.
  const switchServer = useCallback((server: RaftServer) => {
    if (server.id === session.serverId) return Promise.resolve();
    // The picker flag is process-wide. Leaving it open would show the
    // previous server's agent list after the switch.
    closeChoosePm();
    setCurrentServerRole(server.role ?? null);
    return session.selectServer(server.id);
  }, [session]);

  // Returning to a rail-bearing tab refreshes the cross-server dots. The
  // realtime socket only connects to the active server, so this fetch (plus
  // the foreground refresh in the session provider) is the only other-server
  // unread source besides pull-to-refresh.
  // The PM tab mounts this hook three times. Each one used to call the API
  // on the first paint, before the session had an address, and those three
  // promises were uncaught ("Set a server address").
  useFocusEffect(useCallback(() => {
    if (!session.ready || !session.origin) return;
    void refreshBadges(session.client).catch(() => {});
  }, [refreshBadges, session.client, session.origin, session.ready]));

  return { servers, serverUnread, activityUnread, current, switchServer, loadServers };
}
