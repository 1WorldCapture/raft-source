import { useCallback, useLayoutEffect, useState } from "react";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { ApiError } from "../../src/api/client";
import { channelLabel, parseChannelUnread, parseChannels, type RaftChannel } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { useRaftStore } from "../../src/state/store";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";
import { colors, space } from "../../src/ui/theme";

function visibleChannels(channels: RaftChannel[]): RaftChannel[] {
  return channels.filter((channel) => channel.joined !== false && !channel.archivedAt && channel.type !== "thread");
}

export default function ChannelsScreen() {
  const { serverId, name } = useLocalSearchParams<{ serverId: string; name?: string }>();
  const session = useSession();
  const navigation = useNavigation();
  const router = useRouter();
  const [channels, setChannels] = useState<RaftChannel[]>([]);
  const [dms, setDms] = useState<RaftChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const directoryVersion = useRaftStore((state) => state.directoryVersion);
  const channelUnread = useRaftStore((state) => state.channelUnread);
  const liveUnread = useRaftStore((state) => state.liveUnread);

  useLayoutEffect(() => {
    navigation.setOptions({ title: name || "Channels" });
  }, [name, navigation]);

  const load = useCallback(async () => {
    if (session.serverId !== serverId) {
      setLoading(false);
      setError("Open this server from the server list so requests use the right server.");
      return;
    }
    setError(null);
    try {
      const [channelData, dmData, unreadData] = await Promise.all([
        session.client.get<unknown>("/channels?archived=exclude"),
        session.client.get<unknown>("/channels/dm"),
        session.client.get<unknown>("/channels/unread?summary=1"),
      ]);
      setChannels(visibleChannels(parseChannels(channelData).filter((channel) => channel.type !== "dm")).sort((a, b) => channelLabel(a).localeCompare(channelLabel(b))));
      setDms(visibleChannels(parseChannels(dmData).map((channel) => ({ ...channel, type: channel.type || "dm" }))).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "")));
      useRaftStore.getState().setChannelUnread(parseChannelUnread(unreadData));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 0) setError("网络不通。恢复后下拉刷新。");
      else setError(caught instanceof ApiError ? caught.error : "Couldn't load channels");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [serverId, session.client, session.serverId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load, directoryVersion]));

  const rows = [
    ...channels.map((channel) => ({ ...channel, section: "Channels" })),
    ...dms.map((channel) => ({ ...channel, section: "Direct messages" })),
  ];

  if (loading) return <LoadingScreen />;
  if (error) return <ScreenMessage title="Couldn't load channels" body={error} />;

  return (
    <FlatList
      data={rows}
      keyExtractor={(item) => item.id}
      style={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      ListEmptyComponent={<Text style={styles.empty}>No channels yet.</Text>}
      contentContainerStyle={rows.length === 0 ? styles.emptyWrap : undefined}
      renderItem={({ item, index }) => {
        const showHeader = index === 0 || rows[index - 1]?.section !== item.section;
        const summary = channelUnread[item.id];
        const live = liveUnread[item.id] ?? 0;
        const count = (summary?.unreadCount ?? 0) + live;
        const showBadge = count > 0 || summary?.hasMention === true;
        return (
          <View>
            {showHeader ? <Text style={styles.section}>{item.section}</Text> : null}
            <Pressable
              onPress={() => router.push({
                pathname: "/messages/[channelId]",
                params: { channelId: item.id, name: channelLabel(item) },
              })}
              style={styles.row}
            >
              {item.peerAvatarUrl ? <Image source={{ uri: item.peerAvatarUrl }} style={styles.avatar} /> : <Text style={styles.hash}>{item.type === "dm" ? "@" : "#"}</Text>}
              <Text style={styles.name}>{channelLabel(item)}{item.peerType === "agent" ? " · Agent" : ""}</Text>
              {showBadge ? (
                <View style={[styles.badge, summary?.hasMention && styles.mentionBadge]}>
                  <Text style={styles.badgeText}>{count > 0 ? (count > 99 ? "99+" : String(count)) : "@"}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  section: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "700",
    paddingBottom: space.xs,
    paddingHorizontal: space.md,
    paddingTop: space.md,
    textTransform: "uppercase",
  },
  row: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  hash: { color: colors.muted, fontSize: 16, width: 16 },
  avatar: { borderRadius: 12, height: 24, width: 24 },
  mentionBadge: { backgroundColor: "#c2410c" },
  name: { color: colors.ink, flex: 1, fontSize: 16 },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: 9,
    height: 18,
    minWidth: 18,
    paddingHorizontal: 5,
  },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700", lineHeight: 18, textAlign: "center" },
  emptyWrap: { flex: 1, justifyContent: "center" },
  empty: { color: colors.muted, textAlign: "center" },
});
