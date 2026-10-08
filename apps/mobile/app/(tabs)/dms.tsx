import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { ConversationRow } from "../../src/home/ConversationRow";
import { TabHeader } from "../../src/home/TabHeader";
import { channelHasDraft } from "../../src/home/drafts";
import { conversationUnreadCount, filterUnreadConversations } from "../../src/home/conversations";
import { isPmDirectMessage } from "../../src/home/pmState";
import { useDirectory } from "../../src/home/useDirectory";
import { useServerPm } from "../../src/home/useServerPm";
import { useServerRail } from "../../src/home/useServerRail";
import { formatRelativeTime, relativeTimeStrings } from "../../src/tasks/relativeTime";
import { useT } from "../../src/i18n/provider";
import { channelLabel, type RaftChannel } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { useRaftStore } from "../../src/state/store";
import { AppText } from "../../src/ui/text";
import { ScreenMessage } from "../../src/ui/screen";
import { border, color, fontSize } from "../../src/ui/tokens";

/**
 * DMs tab (Rethink UI): one-on-one conversations only. The server PM's DM
 * stays on the PM tab, so it is left out of this list.
 */
export default function DmsScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const { height } = useWindowDimensions();
  const compact = height <= 600;
  const { current } = useServerRail();
  const { loading, error, reload } = useDirectory();
  const { state: pmState } = useServerPm(current?.slug ?? null);
  const conversations = useRaftStore((state) => state.conversations);
  const channelUnread = useRaftStore((state) => state.channelUnread);
  const liveUnread = useRaftStore((state) => state.liveUnread);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const pmAgentId = pmState?.pm?.agentId ?? null;
  const dms = conversations.filter((entry) => entry.channel.type === "dm" && !isPmDirectMessage(entry.channel, pmAgentId));
  const unreadDms = filterUnreadConversations(dms, channelUnread, liveUnread);
  const visible = unreadOnly ? unreadDms : dms;
  const timeStrings = relativeTimeStrings(t);

  const markRead = useCallback((channel: RaftChannel) => {
    Alert.alert(channelLabel(channel), undefined, [
      { text: t("layout.sidebar.markAsRead"), onPress: () => void session.client.post(`/channels/${channel.id}/read-all`).then(() => {
        useRaftStore.getState().clearChannelUnread(channel.id);
        useRaftStore.getState().clearLiveUnread(channel.id);
      }).catch(() => Alert.alert(t("mobile.channels.loadFailed"))) },
      { text: t("search.back"), style: "cancel" },
    ]);
  }, [session.client, t]);

  return (
    <View style={styles.page}>
      <TabHeader title={t("mobile.tabs.dms") + (current ? ` · ${current.name}` : "")} />
      {loading && dms.length === 0 ? (
        <View style={styles.centered}><ActivityIndicator color={color.ink} /></View>
      ) : error && dms.length === 0 ? (
        <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} />
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
                {unreadDms.length > 0
                  ? t("mobile.conversations.unreadOnlyCount", { n: unreadDms.length })
                  : t("mobile.conversations.unreadOnly")}
              </AppText>
            </Pressable>
          }
          ListEmptyComponent={
            <AppText style={styles.empty}>
              {unreadOnly ? t("mobile.conversations.unreadEmpty") : t("mobile.dms.empty")}
            </AppText>
          }
          refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}
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
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  listPane: { flex: 1 },
  centered: { alignItems: "center", flex: 1, justifyContent: "center" },
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
