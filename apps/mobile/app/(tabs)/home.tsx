import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, BackHandler, FlatList, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Activity, Bell, Bookmark, ChevronDown, ChevronRight, Hash, Lock, Pencil, Search } from "lucide-react-native";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { groupHasUnread, groupHomeChannels, pinnedChannelIds, type HomeGroups } from "../../src/home/directory";
import { parseInbox } from "../../src/home/inbox";
import { channelHasDraft } from "../../src/home/drafts";
import { setCurrentServerRole } from "../../src/home/serverRole";
import { useT } from "../../src/i18n/provider";
import { channelLabel, parseChannelUnread, parseChannels, parseServers, parseUnreadSummary, type RaftChannel, type RaftServer } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { useRaftStore } from "../../src/state/store";
import { Avatar } from "../../src/ui/Avatar";
import { Badge, MentionMark } from "../../src/ui/Badge";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";
import { HardShadow } from "../../src/ui/shadow";
import { AppText } from "../../src/ui/text";
import { border, color, fontSize, shadowOffset, size } from "../../src/ui/tokens";

const EMPTY_GROUPS: HomeGroups = { pinned: [], joint: [], channels: [], dms: [] };

export default function HomeScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const headerHeight = (height <= 600 ? size.headerCompact : size.header) + insets.top;
  const directoryVersion = useRaftStore((state) => state.directoryVersion);
  const channelUnread = useRaftStore((state) => state.channelUnread);
  const liveUnread = useRaftStore((state) => state.liveUnread);
  const [servers, setServers] = useState<RaftServer[]>([]);
  const [serverUnread, setServerUnread] = useState<Record<string, number>>({});
  const [groups, setGroups] = useState<HomeGroups>(EMPTY_GROUPS);
  const [activityCount, setActivityCount] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadTicket = useRef(0);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const tRef = useRef(t);
  tRef.current = t;

  const current = servers.find((server) => server.id === session.serverId) ?? null;

  const loadServers = useCallback(async (preferredId: string | null) => {
    const currentSession = sessionRef.current;
    const [serverData, unreadData] = await Promise.all([
      currentSession.client.get<unknown>("/servers", { server: false }),
      currentSession.client.get<unknown>("/servers/unread-summary", { server: false }),
    ]);
    const next = parseServers(serverData);
    setServers(next);
    setServerUnread(parseUnreadSummary(unreadData));
    const selected = next.find((server) => server.id === preferredId) ?? next[0] ?? null;
    setCurrentServerRole(selected?.role ?? null);
    // Use the id this load was given, not a serverId closed over from an earlier render.
    const activeId = preferredId ?? sessionRef.current.serverId;
    if (selected && selected.id !== activeId) await sessionRef.current.selectServer(selected.id);
    return selected;
  }, []);

  const loadDirectory = useCallback(async (serverId: string, ticket: number) => {
    const [channelData, dmData, unreadData, orderData, inboxData] = await Promise.all([
      session.client.get<unknown>("/channels?archived=exclude"),
      session.client.get<unknown>("/channels/dm"),
      session.client.get<unknown>("/channels/unread?summary=1"),
      optionalGet(session.client, `/servers/${serverId}/sidebar-order`),
      optionalGet(session.client, "/channels/inbox?limit=20"),
    ]);
    if (ticket !== loadTicket.current) return;
    const channels = parseChannels(channelData).filter((channel) => channel.type !== "dm");
    const dms = parseChannels(dmData).map((channel) => ({ ...channel, type: channel.type || "dm" }));
    useRaftStore.getState().setChannelUnread(parseChannelUnread(unreadData));
    setGroups(groupHomeChannels([...channels, ...dms], pinnedChannelIds(orderData)));
    setActivityCount(parseInbox(inboxData).totalUnreadCount);
  }, [session.client]);

  const loadFor = useCallback(async (preferredId: string | null) => {
    const ticket = ++loadTicket.current;
    setError(null);
    try {
      const selected = await loadServers(preferredId);
      if (ticket !== loadTicket.current) return;
      if (!selected) {
        setGroups(EMPTY_GROUPS);
        return;
      }
      await loadDirectory(selected.id, ticket);
    } catch (caught) {
      if (ticket !== loadTicket.current || caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : tRef.current("mobile.channels.loadFailed"));
    } finally {
      if (ticket === loadTicket.current) setLoading(false);
    }
  }, [loadDirectory, loadServers]);

  const loadForRef = useRef(loadFor);
  loadForRef.current = loadFor;

  // useFocusEffect can miss the first focus on a cold start. Load from session
  // readiness as well, and keep the focus callback stable so a render does not
  // cancel the request before the spinner can clear.
  useEffect(() => {
    if (!session.ready) return;
    void loadFor(session.serverId);
  }, [loadFor, directoryVersion, session.ready, session.serverId]);

  useFocusEffect(useCallback(() => {
    if (!sessionRef.current.ready) return;
    void loadForRef.current(sessionRef.current.serverId);
  }, []));

  useEffect(() => {
    if (!menu) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setMenu(false);
      return true;
    });
    return () => subscription.remove();
  }, [menu]);

  const markRead = useCallback((channel: RaftChannel) => {
    Alert.alert(channelLabel(channel), undefined, [
      { text: t("layout.sidebar.markAsRead"), onPress: () => void session.client.post(`/channels/${channel.id}/read-all`).then(() => {
        useRaftStore.getState().clearChannelUnread(channel.id);
        useRaftStore.getState().clearLiveUnread(channel.id);
      }).catch(() => Alert.alert(t("mobile.channels.loadFailed"))) },
      { text: t("search.back"), style: "cancel" },
    ]);
  }, [session.client, t]);

  if (loading) return <LoadingScreen />;
  if (error) return <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} />;

  const sections = [
    { id: "pinned", title: t("layout.sidebar.pinned"), channels: groups.pinned, empty: t("layout.sidebar.pinnedEmptyHint") },
    { id: "joint", title: t("layout.sidebar.jointChannels"), channels: groups.joint, empty: t("layout.sidebar.jointChannelsEmpty") },
    { id: "channels", title: t("layout.sidebar.channels"), channels: groups.channels, empty: null },
    { id: "dms", title: t("layout.sidebar.directMessages"), channels: groups.dms, empty: null },
  ];

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
        <Pressable accessibilityRole="button" onPress={() => router.push("/activity")} style={styles.icon}>
          <Bell color={color.ink} size={18} />
        </Pressable>
      </View>
      <FlatList
        data={sections}
        keyExtractor={(section) => section.id}
        ListHeaderComponent={
          <View>
            <Entry compact={height <= 600} icon={<Search color={color.ink} size={16} />} label={t("layout.sidebar.search")} onPress={() => router.push("/search")} />
            <Entry compact={height <= 600} icon={<Activity color={color.ink} size={16} />} label={t("layout.sidebar.activity")} count={activityCount} onPress={() => router.push("/activity")} />
            <Entry compact={height <= 600} icon={<Bookmark color={color.ink} size={16} />} label={t("layout.sidebar.saved")} onPress={() => router.push("/saved")} />
          </View>
        }
        renderItem={({ item }) => {
          const closed = collapsed[item.id] === true;
          return (
            <View>
              <Pressable accessibilityRole="button" onPress={() => setCollapsed((state) => ({ ...state, [item.id]: !closed }))} style={styles.section}>
                {closed ? <ChevronRight color={color.ink} size={14} strokeWidth={2.5} /> : <ChevronDown color={color.ink} size={14} strokeWidth={2.5} />}
                <AppText style={styles.sectionTitle}>{item.title}</AppText>
                <AppText style={styles.sectionCount}>{String(item.channels.length)}</AppText>
                {closed && groupHasUnread(item.channels, channelUnread, liveUnread) ? <View style={styles.dot} /> : null}
              </Pressable>
              {!closed && item.channels.length === 0 && item.empty ? <AppText style={styles.sectionEmpty}>{item.empty}</AppText> : null}
              {closed ? null : item.channels.map((channel) => (
                <ChannelRow compact={height <= 600} key={channel.id} channel={channel} onOpen={() => router.push({ pathname: "/messages/[channelId]", params: { channelId: channel.id, name: channelLabel(channel) } })} onLongPress={() => markRead(channel)} />
              ))}
            </View>
          );
        }}
      />
      <Modal animationType="fade" transparent visible={menu} onRequestClose={() => setMenu(false)}>
        <Pressable style={[styles.backdrop, { paddingTop: headerHeight }]} onPress={() => setMenu(false)}>
          <View style={styles.menu}>
            {servers.map((server) => (
              <Pressable key={server.id} onPress={() => {
                setMenu(false);
                if (server.id === session.serverId) return;
                setGroups(EMPTY_GROUPS);
                setActivityCount(0);
                setLoading(true);
                setError(null);
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

function Entry({ icon, label, count, onPress, compact }: { icon?: ReactNode; label: string; count?: number; onPress: () => void; compact?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.row, compact ? styles.rowCompact : null]}>
      {icon ?? <View style={styles.iconGap} />}
      <AppText style={styles.name}>{label}</AppText>
      <Badge count={count ?? 0} />
    </Pressable>
  );
}

function ChannelRow({ channel, onOpen, onLongPress, compact }: { channel: RaftChannel; onOpen: () => void; onLongPress: () => void; compact?: boolean }) {
  const unread = useRaftStore((state) => state.channelUnread[channel.id]);
  const live = useRaftStore((state) => state.liveUnread[channel.id] ?? 0);
  const count = (unread?.unreadCount ?? 0) + live;
  const bold = count > 0 || unread?.hasMention === true;
  const dm = channel.type === "dm";
  return (
    <Pressable delayLongPress={500} onLongPress={onLongPress} onPress={onOpen} style={[styles.row, compact ? styles.rowCompact : null]}>
      {dm ? <Avatar name={channelLabel(channel)} kind={channel.peerType === "agent" ? "agent" : "human"} avatarUrl={channel.peerAvatarUrl} size={18} /> : channel.type === "private" ? <Lock color={color.ink} size={16} /> : <Hash color={color.ink} size={16} />}
      <AppText numberOfLines={1} style={[styles.name, bold ? styles.unread : null]}>{channelLabel(channel)}</AppText>
      <Badge count={count} quiet={channel.activityMuted} />
      {unread?.hasMention ? <MentionMark /> : null}
      {channelHasDraft(channel.id) ? <Pencil color={color.ink} size={14} /> : null}
    </Pressable>
  );
}

async function optionalGet(client: { get: (path: string) => Promise<unknown> }, path: string): Promise<unknown> {
  try {
    return await client.get(path);
  } catch (caught) {
    if (caught instanceof StaleRequestError) throw caught;
    return {};
  }
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
  switcherWrap: { maxWidth: "75%" },
  switcher: { alignItems: "center", backgroundColor: color.ink, borderColor: color.border, borderWidth: border.strong, flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 7 },
  switcherName: { color: color.yellow, fontSize: 18, fontWeight: "700", lineHeight: 22 },
  switcherDot: { backgroundColor: color.pink, borderColor: color.border, borderRadius: 5, borderWidth: 1, height: 10, position: "absolute", right: -2, top: -2, width: 10 },
  serverName: { color: color.ink, fontSize: 14, fontWeight: "700" },
  icon: { alignItems: "center", height: size.iconButton, justifyContent: "center", width: size.iconButton },
  section: { alignItems: "center", flexDirection: "row", gap: 4, height: 24, marginBottom: 4, marginTop: 16, paddingHorizontal: 16 },
  sectionTitle: { ...fontSize.group, color: color.ink, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  sectionCount: { ...fontSize.group, color: color.muted, fontFamily: "mono", marginLeft: 2 },
  sectionEmpty: { ...fontSize.group, color: color.muted, paddingBottom: 4, paddingHorizontal: 16 },
  row: { alignItems: "center", borderColor: "transparent", borderWidth: 2, flexDirection: "row", gap: 10, marginBottom: 4, paddingHorizontal: 16, paddingVertical: 8 },
  rowCompact: { paddingVertical: 4 },
  name: { ...fontSize.list, color: color.ink, flex: 1, fontWeight: "500" },
  unread: { fontWeight: "700" },
  iconGap: { width: 16 },
  dot: { backgroundColor: color.pink, borderRadius: 4, height: 8, width: 8 },
  backdrop: { backgroundColor: color.muted, flex: 1, justifyContent: "flex-start" },
  menu: { backgroundColor: color.page, borderColor: color.border, borderWidth: 2, marginHorizontal: 16 },
  menuRow: { alignItems: "center", flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  menuCurrent: { backgroundColor: color.yellow },
});
