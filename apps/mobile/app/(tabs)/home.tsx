import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, BackHandler, FlatList, Modal, Pressable, RefreshControl, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Activity, Bookmark, ChevronDown, Search } from "lucide-react-native";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { ConversationRow } from "../../src/home/ConversationRow";
import { channelHasDraft } from "../../src/home/drafts";
import { conversationUnreadCount, filterUnreadConversations } from "../../src/home/conversations";
import { activityUnreadByServer } from "../../src/activity/model";
import { setCurrentServerRole } from "../../src/home/serverRole";
import { formatRelativeTime, relativeTimeStrings } from "../../src/tasks/relativeTime";
import { useT } from "../../src/i18n/provider";
import { channelLabel, parseChannelUnread, parseChannels, parseServers, parseUnreadSummary, type RaftChannel, type RaftServer } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { useRaftStore } from "../../src/state/store";
import { Badge } from "../../src/ui/Badge";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";
import { HardShadow } from "../../src/ui/shadow";
import { AppText } from "../../src/ui/text";
import { border, color, fontSize, shadowOffset, size } from "../../src/ui/tokens";

// Directory bumps (socket catch-up, a live message for a never-listed channel)
// coalesce into one full reload behind this delay.
const DIRECTORY_REFRESH_DEBOUNCE_MS = 1500;

export default function HomeScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const compact = height <= 600;
  const headerHeight = (compact ? size.headerCompact : size.header) + insets.top;
  const conversations = useRaftStore((state) => state.conversations);
  const channelUnread = useRaftStore((state) => state.channelUnread);
  const liveUnread = useRaftStore((state) => state.liveUnread);
  const directoryVersion = useRaftStore((state) => state.directoryVersion);
  const [servers, setServers] = useState<RaftServer[]>([]);
  const [serverUnread, setServerUnread] = useState<Record<string, number>>({});
  const [activityUnread, setActivityUnread] = useState<Record<string, number>>({});
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [menu, setMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadTicket = useRef(0);
  const directoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const tRef = useRef(t);
  tRef.current = t;

  const current = servers.find((server) => server.id === session.serverId) ?? null;
  const activityCount = activityUnread[session.serverId ?? ""] ?? 0;

  useEffect(() => () => {
    if (directoryTimer.current) clearTimeout(directoryTimer.current);
  }, []);

  const loadServers = useCallback(async (preferredId: string | null) => {
    const currentSession = sessionRef.current;
    const [serverData, unreadData] = await Promise.all([
      currentSession.client.get<unknown>("/servers", { server: false }),
      currentSession.client.get<unknown>("/servers/unread-summary", { server: false }),
    ]);
    const next = parseServers(serverData);
    setServers(next);
    setServerUnread(parseUnreadSummary(unreadData));
    setActivityUnread(activityUnreadByServer(unreadData));
    const selected = next.find((server) => server.id === preferredId) ?? next[0] ?? null;
    setCurrentServerRole(selected?.role ?? null);
    // Use the id this load was given, not a serverId closed over from an earlier render.
    const activeId = preferredId ?? sessionRef.current.serverId;
    if (selected && selected.id !== activeId) await sessionRef.current.selectServer(selected.id);
    return selected;
  }, []);

  const loadDirectory = useCallback(async (serverId: string, ticket: number) => {
    const [channelData, dmData, unreadData] = await Promise.all([
      session.client.get<unknown>("/channels?archived=exclude"),
      session.client.get<unknown>("/channels/dm"),
      session.client.get<unknown>("/channels/unread?summary=1"),
    ]);
    if (ticket !== loadTicket.current) return;
    const channels = parseChannels(channelData).filter((channel) => channel.type !== "dm");
    const dms = parseChannels(dmData).map((channel) => ({ ...channel, type: channel.type || "dm" }));
    useRaftStore.getState().setChannelUnread(parseChannelUnread(unreadData));
    useRaftStore.getState().setConversations([...channels, ...dms]);
  }, [session.client]);

  const loadFor = useCallback(async (preferredId: string | null) => {
    const ticket = ++loadTicket.current;
    setError(null);
    try {
      const selected = await loadServers(preferredId);
      if (ticket !== loadTicket.current) return;
      if (!selected) {
        useRaftStore.getState().setConversations([]);
        return;
      }
      await loadDirectory(selected.id, ticket);
    } catch (caught) {
      if (ticket !== loadTicket.current || caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : tRef.current("mobile.channels.loadFailed"));
    } finally {
      if (ticket === loadTicket.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [loadDirectory, loadServers]);

  const loadForRef = useRef(loadFor);
  loadForRef.current = loadFor;

  // Initial load and server switches load immediately. Tab focus does NOT
  // reload: realtime events keep the list fresh and pull-to-refresh is the
  // explicit escape hatch (task #2/#6).
  useEffect(() => {
    if (!session.ready) return;
    void loadFor(session.serverId);
  }, [loadFor, session.ready, session.serverId]);

  // Directory bumps reload the list after a debounce, so a burst of bumps
  // (catch-up after reconnect, several new conversations at once) coalesces.
  const seenDirectoryVersion = useRef(directoryVersion);
  useEffect(() => {
    if (seenDirectoryVersion.current === directoryVersion) return;
    seenDirectoryVersion.current = directoryVersion;
    if (!sessionRef.current.ready) return;
    if (directoryTimer.current) clearTimeout(directoryTimer.current);
    directoryTimer.current = setTimeout(() => {
      directoryTimer.current = null;
      void loadForRef.current(sessionRef.current.serverId);
    }, DIRECTORY_REFRESH_DEBOUNCE_MS);
  }, [directoryVersion]);

  useEffect(() => {
    if (!menu) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setMenu(false);
      return true;
    });
    return () => subscription.remove();
  }, [menu]);

  // Returning to the tab no longer reloads the list, but the header badges
  // (activity count, other-server dots) would sit stale until the next full
  // reload — refresh just the unread summary instead (review point on #52).
  useFocusEffect(useCallback(() => {
    const startedTicket = loadTicket.current;
    const currentSession = sessionRef.current;
    if (!currentSession.ready) return;
    void currentSession.client.get<unknown>("/servers/unread-summary", { server: false })
      .then((data) => {
        if (startedTicket !== loadTicket.current) return;
        setServerUnread(parseUnreadSummary(data));
        setActivityUnread(activityUnreadByServer(data));
      })
      .catch(() => {});
  }, []));

  const markRead = useCallback((channel: RaftChannel) => {
    Alert.alert(channelLabel(channel), undefined, [
      { text: t("layout.sidebar.markAsRead"), onPress: () => void session.client.post(`/channels/${channel.id}/read-all`).then(() => {
        useRaftStore.getState().clearChannelUnread(channel.id);
        useRaftStore.getState().clearLiveUnread(channel.id);
      }).catch(() => Alert.alert(t("mobile.channels.loadFailed"))) },
      { text: t("search.back"), style: "cancel" },
    ]);
  }, [session.client, t]);

  if (loading && conversations.length === 0) return <LoadingScreen />;
  if (error && conversations.length === 0) return <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} />;

  const visible = unreadOnly ? filterUnreadConversations(conversations, channelUnread, liveUnread) : conversations;
  const timeStrings = relativeTimeStrings(t);

  return (
    <View style={styles.page}>
      <View style={[styles.header, { height: headerHeight, paddingTop: insets.top }]}>
        <Pressable accessibilityRole="button" onPress={() => setMenu(true)} style={styles.switcherWrap}>
          <HardShadow offset={shadowOffset.sm}>
            <View style={styles.switcher}>
              <AppText numberOfLines={1} style={styles.switcherName}>{current?.name || t("mobile.servers.title")}</AppText>
              <ChevronDown color={color.yellow} size={16} strokeWidth={2.5} />
            </View>
          </HardShadow>
          {servers.some((server) => server.id !== current?.id && (serverUnread[server.id] ?? 0) > 0) ? <View style={styles.switcherDot} /> : null}
        </Pressable>
        <View style={styles.headerIcons}>
          <Pressable accessibilityRole="button" onPress={() => router.push("/search")} style={styles.icon}>
            <Search color={color.ink} size={18} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.push("/activity")} style={styles.icon}>
            <Activity color={color.ink} size={18} />
            <View style={styles.activityBadge}>
              <Badge count={activityCount} />
            </View>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => router.push("/saved")} style={styles.icon}>
            <Bookmark color={color.ink} size={18} />
          </Pressable>
        </View>
      </View>
      <FlatList
        data={visible}
        keyExtractor={(entry) => entry.channel.id}
        ListHeaderComponent={
          <Pressable
            accessibilityRole="button"
            onPress={() => setUnreadOnly((value) => !value)}
            style={[styles.unreadToggle, unreadOnly ? styles.unreadToggleActive : null]}
          >
            <AppText style={styles.unreadToggleLabel}>{t("mobile.conversations.unreadOnly")}</AppText>
          </Pressable>
        }
        ListEmptyComponent={
          <AppText style={styles.empty}>
            {unreadOnly ? t("mobile.conversations.unreadEmpty") : t("mobile.channels.empty")}
          </AppText>
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void loadFor(sessionRef.current.serverId);
            }}
          />
        }
        renderItem={({ item }) => (
          <ConversationRow
            channel={item.channel}
            compact={compact}
            hasDraft={channelHasDraft(item.channel.id)}
            hasMention={channelUnread[item.channel.id]?.hasMention === true}
            onLongPress={() => markRead(item.channel)}
            onPress={() => router.push({ pathname: "/messages/[channelId]", params: { channelId: item.channel.id, name: channelLabel(item.channel) } })}
            preview={item.preview}
            timeText={formatRelativeTime(item.channel.lastMessageAt, timeStrings)}
            unreadCount={conversationUnreadCount(item.channel.id, channelUnread, liveUnread)}
          />
        )}
      />
      <Modal animationType="fade" transparent visible={menu} onRequestClose={() => setMenu(false)}>
        <Pressable style={[styles.backdrop, { paddingTop: headerHeight }]} onPress={() => setMenu(false)}>
          <View style={styles.menu}>
            {servers.map((server) => (
              <Pressable key={server.id} onPress={() => {
                setMenu(false);
                if (server.id === session.serverId) return;
                setLoading(true);
                setError(null);
                useRaftStore.getState().setConversations([]);
                setCurrentServerRole(server.role ?? null);
                void session.selectServer(server.id).then(() => loadFor(server.id));
              }} style={[styles.menuRow, server.id === current?.id ? styles.menuCurrent : null]}>
                <AppText style={styles.serverName}>{server.name}</AppText>
                {(serverUnread[server.id] ?? 0) > 0 && server.id !== current?.id ? <View style={styles.dot} /> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  header: {
    alignItems: "center",
    backgroundColor: color.yellow,
    borderBottomColor: color.border,
    borderBottomWidth: 2,
    flexDirection: "row",
    height: size.header,
    justifyContent: "space-between",
    paddingHorizontal: 12,
  },
  switcherWrap: { maxWidth: "60%" },
  switcher: { alignItems: "center", backgroundColor: color.ink, borderColor: color.border, borderWidth: border.strong, flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 7 },
  switcherName: { color: color.yellow, fontSize: 18, fontWeight: "700", lineHeight: 22 },
  switcherDot: { backgroundColor: color.pink, borderColor: color.border, borderRadius: 5, borderWidth: 1, height: 10, position: "absolute", right: -2, top: -2, width: 10 },
  headerIcons: { alignItems: "center", flexDirection: "row", gap: 4 },
  icon: { alignItems: "center", height: size.iconButton, justifyContent: "center", width: size.iconButton },
  activityBadge: { position: "absolute", right: 0, top: 2 },
  unreadToggle: {
    alignSelf: "flex-start",
    borderColor: color.border,
    borderWidth: border.strong,
    marginBottom: 4,
    marginLeft: 16,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  unreadToggleActive: { backgroundColor: color.yellow },
  unreadToggleLabel: { ...fontSize.group, color: color.ink, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1.2 },
  empty: { ...fontSize.list, color: color.muted, padding: 16 },
  serverName: { color: color.ink, fontSize: 14, fontWeight: "700" },
  dot: { backgroundColor: color.pink, borderRadius: 4, height: 8, width: 8 },
  backdrop: { backgroundColor: color.muted, flex: 1, justifyContent: "flex-start" },
  menu: { backgroundColor: color.page, borderColor: color.border, borderWidth: 2, marginHorizontal: 16 },
  menuRow: { alignItems: "center", flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  menuCurrent: { backgroundColor: color.yellow },
});
