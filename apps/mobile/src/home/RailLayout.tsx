import { useCallback, useEffect, type ReactNode } from "react";
import { Alert, StyleSheet, View, useWindowDimensions } from "react-native";
import type { RaftServer } from "../model/messages";
import { useSession } from "../state/session";
import { useT } from "../i18n/provider";
import { ServerRail } from "./ServerRail";
import { useServerRail } from "./useServerRail";
import { useServerRailStore } from "./serverRailStore";

// Shared "server rail + page body" layout for the tab roots
// (#mobile-server-rail task #2). Home passes its own onSelect (it clears and
// reloads its list in place); tasks and members use the shared switch, and
// reload their own data off session.serverId.
export function RailLayout({ children, onSelect }: { children: ReactNode; onSelect?: (server: RaftServer) => void }) {
  const session = useSession();
  const t = useT();
  const { height } = useWindowDimensions();
  const { servers, serverUnread, switchServer, loadServers } = useServerRail();

  // A tab opened before home has loaded (deep link, restored tab) still needs
  // the server list for its rail.
  useEffect(() => {
    if (!session.ready || servers.length > 0) return;
    void loadServers(session.client, session.serverId);
  }, [loadServers, servers.length, session.client, session.ready, session.serverId]);

  // Drag reorder (task #4): the store applies the order optimistically and
  // rolls back on failure — surface that failure once, here, for every tab.
  const onReorder = useCallback((orderedIds: string[]) => {
    void useServerRailStore.getState().reorderServers(session.client, orderedIds)
      .then((saved) => {
        if (!saved) Alert.alert(t("mobile.servers.reorderFailed"));
      });
  }, [session.client, t]);

  return (
    <View style={styles.body}>
      <ServerRail
        compact={height <= 600}
        currentId={session.serverId}
        onSelect={onSelect ?? ((server) => void switchServer(server))}
        onReorder={onReorder}
        servers={servers}
        unreadByServer={serverUnread}
      />
      <View style={styles.pane}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, flexDirection: "row" },
  pane: { flex: 1 },
});
