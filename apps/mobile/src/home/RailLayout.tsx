import { useEffect, type ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import type { RaftServer } from "../model/messages";
import { useSession } from "../state/session";
import { ServerRail } from "./ServerRail";
import { useServerRail } from "./useServerRail";

// Shared "server rail + page body" layout for the tab roots
// (#mobile-server-rail task #2). Home passes its own onSelect (it clears and
// reloads its list in place); tasks and members use the shared switch, and
// reload their own data off session.serverId.
export function RailLayout({ children, onSelect }: { children: ReactNode; onSelect?: (server: RaftServer) => void }) {
  const session = useSession();
  const { height } = useWindowDimensions();
  const { servers, serverUnread, switchServer, loadServers } = useServerRail();

  // A tab opened before home has loaded (deep link, restored tab) still needs
  // the server list for its rail.
  useEffect(() => {
    if (!session.ready || servers.length > 0) return;
    void loadServers(session.client, session.serverId);
  }, [loadServers, servers.length, session.client, session.ready, session.serverId]);

  return (
    <View style={styles.body}>
      <ServerRail
        compact={height <= 600}
        currentId={session.serverId}
        onSelect={onSelect ?? ((server) => void switchServer(server))}
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
