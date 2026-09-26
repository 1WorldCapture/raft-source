import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, BackHandler, FlatList, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Bell, ChevronDown, Hash, Pencil, Search } from "lucide-react-native";
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
import { AppText } from "../../src/ui/text";
import { color, fontSize, size } from "../../src/ui/tokens";

const EMPTY_GROUPS: HomeGroups = { pinned: [], joint: [], channels: [], dms: [] };

export default function HomeScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
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
  const { height } = useWindowDimensions();

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
    { id: "pinned", title: t("layout.sidebar.pinned"), channels: groups.pinned },
    { id: "joint", title: t("layout.sidebar.jointChannels"), channels: groups.joint },
    { id: "channels", title: t("layout.sidebar.channels"), channels: groups.channels },
    { id: "dms", title: t("layout.sidebar.directMessages"), channels: groups.dms },
  ].filter((section) => section.channels.length > 0);

  return (
    <View style={styles.page}>
      <View style={[styles.header, { height: height <= 600 ? size.headerCompact : size.header }]}>
        <Pressable accessibilityRole="button" onPress={() => setMenu(true)} style={styles.switcher}>
          <AppText numberOfLines={1} style={styles.serverName}>{current?.name || t("mobile.servers.title")}</AppText>
          <ChevronDown color={color.ink} size={16} />
          {servers.some((server) => server.id !== current?.id && (serverUnread[server.id] ?? 0) > 0) ? <View style={styles.dot} /> : null}
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
            <Entry icon={<Search color={color.ink} size={16} />} label={t("layout.sidebar.search")} onPress={() => router.push("/search")} />
            <Entry icon={<Bell color={color.ink} size={16} />} label={t("layout.sidebar.activity")} count={activityCount} onPress={() => router.push("/activity")} />
            <Entry label={t("layout.sidebar.saved")} onPress={() => router.push("/saved")} />
          </View>
        }
        renderItem={({ item }) => {
          const closed = collapsed[item.id] === true;
          return (
            <View>
              <Pressable onPress={() => setCollapsed((state) => ({ ...state, [item.id]: !closed }))} style={styles.section}>
                <AppText style={styles.sectionTitle}>{item.title}</AppText>
                {closed && groupHasUnread(item.channels, channelUnread, liveUnread) ? <View style={styles.dot} /> : null}
              </Pressable>
              {closed ? null : item.channels.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} onOpen={() => router.push({ pathname: "/messages/[channelId]", params: { channelId: channel.id, name: channelLabel(channel) } })} onLongPress={() => markRead(channel)} />
              ))}
            </View>
          );
        }}
      />
      <Modal animationType="fade" transparent visible={menu} onRequestClose={() => setMenu(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenu(false)}>
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

function Entry({ icon, label, count, onPress }: { icon?: ReactNode; label: string; count?: number; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      {icon ?? <View style={styles.iconGap} />}
      <AppText style={styles.name}>{label}</AppText>
      <Badge count={count ?? 0} />
    </Pressable>
  );
}

function ChannelRow({ channel, onOpen, onLongPress }: { channel: RaftChannel; onOpen: () => void; onLongPress: () => void }) {
  const unread = useRaftStore((state) => state.channelUnread[channel.id]);
  const live = useRaftStore((state) => state.liveUnread[channel.id] ?? 0);
  const count = (unread?.unreadCount ?? 0) + live;
  const bold = count > 0 || unread?.hasMention === true;
  const dm = channel.type === "dm";
  return (
    <Pressable delayLongPress={500} onLongPress={onLongPress} onPress={onOpen} style={styles.row}>
      {dm ? <Avatar name={channelLabel(channel)} kind={channel.peerType === "agent" ? "agent" : "human"} avatarUrl={channel.peerAvatarUrl} size={28} /> : <Hash color={color.ink} size={16} />}
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
  switcher: { alignItems: "center", borderColor: color.border, borderRadius: 999, borderWidth: 2, flexDirection: "row", gap: 6, maxWidth: "75%", paddingHorizontal: 12, paddingVertical: 6 },
  serverName: { color: color.ink, fontSize: 14, fontWeight: "700" },
  icon: { alignItems: "center", height: size.iconButton, justifyContent: "center", width: size.iconButton },
  section: { alignItems: "center", flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 16 },
  sectionTitle: { ...fontSize.group, color: color.ink, fontWeight: "700", letterSpacing: 0.8, textTransform: "uppercase" },
  row: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  name: { color: color.ink, flex: 1, fontSize: 14 },
  unread: { fontWeight: "700" },
  iconGap: { width: 16 },
  dot: { backgroundColor: color.pink, borderRadius: 4, height: 8, width: 8 },
  backdrop: { backgroundColor: color.muted, flex: 1, justifyContent: "flex-start", paddingTop: 72 },
  menu: { backgroundColor: color.page, borderColor: color.border, borderWidth: 2, marginHorizontal: 16 },
  menuRow: { alignItems: "center", flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  menuCurrent: { backgroundColor: color.yellow },
});
