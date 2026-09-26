import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError, StaleRequestError } from "../src/api/client";
import { useT } from "../src/i18n/provider";
import { parseServers, parseUnreadSummary, userLabel, type RaftServer } from "../src/model/messages";
import { useSession } from "../src/state/session";
import { LoadingScreen, ScreenMessage } from "../src/ui/screen";
import { colors, space } from "../src/ui/theme";

export default function ServersScreen() {
  const session = useSession();
  const router = useRouter();
  const [servers, setServers] = useState<RaftServer[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [serverData, unreadData] = await Promise.all([
        session.client.get<unknown>("/servers", { server: false }),
        session.client.get<unknown>("/servers/unread-summary", { server: false }),
      ]);
      setServers(parseServers(serverData));
      setUnread(parseUnreadSummary(unreadData));
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : t("mobile.servers.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [session.client, t]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  if (loading) return <LoadingScreen />;
  if (error) return <ScreenMessage title={t("mobile.servers.loadFailed")} body={error} />;

  return (
    <View style={styles.page}>
      <FlatList
        data={servers}
        keyExtractor={(server) => server.id}
        ListEmptyComponent={<Text style={styles.empty}>{t("mobile.servers.empty")}</Text>}
        contentContainerStyle={servers.length === 0 ? styles.emptyWrap : undefined}
        renderItem={({ item }) => {
          const count = unread[item.id] ?? 0;
          return (
            <Pressable
              onPress={() => {
                void session.selectServer(item.id).then(() => {
                  router.push({ pathname: "/channels/[serverId]", params: { serverId: item.id, name: item.name } });
                });
              }}
              style={styles.row}
            >
              <View style={styles.avatar}><Text style={styles.avatarText}>{item.name.slice(0, 1).toUpperCase()}</Text></View>
              <View style={styles.meta}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.slug}>{item.slug}</Text>
              </View>
              {count > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{count > 99 ? "99+" : String(count)}</Text></View> : null}
            </Pressable>
          );
        }}
      />
      <View style={styles.footer}>
        <Text style={styles.who}>{userLabel(session.user) || t("mobile.account.signedIn")}</Text>
        <Pressable onPress={() => void session.logout().then(() => router.replace("/login"))}>
          <Text style={styles.link}>{t("pages.serverSelector.logOut")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  row: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  avatar: {
    alignItems: "center",
    backgroundColor: colors.accentSoft,
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  avatarText: { color: colors.accent, fontWeight: "700" },
  meta: { flex: 1 },
  name: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  slug: { color: colors.muted, fontSize: 13 },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: colors.mineText, fontSize: 12, fontWeight: "700", textAlign: "center" },
  emptyWrap: { flex: 1, justifyContent: "center" },
  empty: { color: colors.muted, textAlign: "center" },
  footer: {
    alignItems: "center",
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: space.md,
  },
  who: { color: colors.muted, flex: 1 },
  link: { color: colors.accent, fontWeight: "600" },
});
