import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Activity, Bookmark, Search } from "lucide-react-native";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { ConversationRow } from "../../src/home/ConversationRow";
import { RailLayout } from "../../src/home/RailLayout";
import { channelHasDraft } from "../../src/home/drafts";
import { conversationUnreadCount, filterUnreadConversations } from "../../src/home/conversations";
import { setCurrentServerRole } from "../../src/home/serverRole";
import { serversFromCacheValue } from "../../src/home/serverRailCache";
import { useServerRail } from "../../src/home/useServerRail";
import { useServerRailStore } from "../../src/home/serverRailStore";
import { formatRelativeTime, relativeTimeStrings } from "../../src/tasks/relativeTime";
import { useT } from "../../src/i18n/provider";
import { seedConversations } from "../../src/cache/boot";
import { pruneToHistoryLimit, reconcileAfterChannelRefresh } from "../../src/cache/cacheCleanup";
import { getCacheRuntime } from "../../src/cache/runtime";
import { channelLabel, parseChannelUnread, parseChannels, type RaftChannel, type RaftServer } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { useRaftStore } from "../../src/state/store";
import { Badge } from "../../src/ui/Badge";
import { ScreenMessage } from "../../src/ui/screen";
import { AppText } from "../../src/ui/text";
import { border, color, fontSize, size } from "../../src/ui/tokens";

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
  const { activityUnread, current, switchServer, loadServers } = useServerRail();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadTicket = useRef(0);
  const directoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const tRef = useRef(t);
  tRef.current = t;

  const activityCount = activityUnread[session.serverId ?? ""] ?? 0;

  useEffect(() => () => {
    if (directoryTimer.current) clearTimeout(directoryTimer.current);
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
    const ticket = ++loadTicket.current;
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
        const seeded = seedConversations(runtime.repo.getChannels(scope));
        if (seeded.length > 0) useRaftStore.getState().setConversations(seeded);
        const cachedUnread = runtime.repo.getKv(scope, "channelUnread");
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
      // writes; this screen's ticket guards the directory below.
      const result = await loadServers(sessionRef.current.client, preferredId);
      if (ticket !== loadTicket.current) return;
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
        const scope = runtime.scopeFor(selected.id);
        if (scope !== null) await pruneToHistoryLimit(runtime.repo, scope, selected);
      } catch {
        // Cache unavailable — the server-side limit still applies.
      }
      // Use the id this load was given, not a serverId closed over from an earlier render.
      const activeId = preferredId ?? sessionRef.current.serverId;
      if (selected.id !== activeId) await sessionRef.current.selectServer(selected.id);
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

  // Badge refresh on tab focus and on returning from the background now live
  // in useServerRail / the session provider (task #1) — shared by every tab.

  const markRead = useCallback((channel: RaftChannel) => {
    Alert.alert(channelLabel(channel), undefined, [
      { text: t("layout.sidebar.markAsRead"), onPress: () => void session.client.post(`/channels/${channel.id}/read-all`).then(() => {
        useRaftStore.getState().clearChannelUnread(channel.id);
        useRaftStore.getState().clearLiveUnread(channel.id);
      }).catch(() => Alert.alert(t("mobile.channels.loadFailed"))) },
      { text: t("search.back"), style: "cancel" },
    ]);
  }, [session.client, t]);

  const selectServer = (server: RaftServer) => {
    if (server.id === session.serverId) return;
    setLoading(true);
    setError(null);
    useRaftStore.getState().setConversations([]);
    void switchServer(server).then(() => loadFor(server.id));
  };

  const unreadConversations = filterUnreadConversations(conversations, channelUnread, liveUnread);
  const visible = unreadOnly ? unreadConversations : conversations;
  const timeStrings = relativeTimeStrings(t);

  return (
    <View style={styles.page}>
      <View style={[styles.header, { height: headerHeight, paddingTop: insets.top }]}>
        <AppText numberOfLines={1} style={styles.serverTitle}>{current?.name || t("mobile.servers.title")}</AppText>
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
      <RailLayout onSelect={selectServer}>
        {loading && conversations.length === 0 ? (
          <View style={styles.centered}><ActivityIndicator color={color.ink} /></View>
        ) : error && conversations.length === 0 ? (
          <View style={styles.listPane}><ScreenMessage title={t("mobile.channels.loadFailed")} body={error} /></View>
        ) : (
          <FlatList
            style={styles.listPane}
            data={visible}
            contentContainerStyle={styles.listContent}
            keyExtractor={(entry) => entry.channel.id}
            ListHeaderComponent={
              <Pressable
                accessibilityRole="button"
                onPress={() => setUnreadOnly((value) => !value)}
                style={[styles.unreadToggle, unreadOnly ? styles.unreadToggleActive : null]}
              >
                <AppText style={styles.unreadToggleLabel}>
                  {unreadConversations.length > 0
                    ? t("mobile.conversations.unreadOnlyCount", { n: unreadConversations.length })
                    : t("mobile.conversations.unreadOnly")}
                </AppText>
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
        )}
      </RailLayout>
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
  serverTitle: { color: color.ink, flexShrink: 1, fontSize: 20, fontWeight: "700", lineHeight: 24, marginRight: 8 },
  listPane: { flex: 1 },
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
  headerIcons: { alignItems: "center", flexDirection: "row", gap: 4 },
  icon: { alignItems: "center", height: size.iconButton, justifyContent: "center", width: size.iconButton },
  activityBadge: { position: "absolute", right: 0, top: 2 },
  unreadToggle: {
    alignSelf: "flex-start",
    borderColor: color.border,
    borderWidth: border.strong,
    marginBottom: 10,
    marginLeft: 12,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  unreadToggleActive: { backgroundColor: color.yellow },
  unreadToggleLabel: { ...fontSize.group, color: color.ink, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1.2 },
  listContent: { paddingBottom: 16 },
  empty: { ...fontSize.list, color: color.muted, padding: 16 },
});
