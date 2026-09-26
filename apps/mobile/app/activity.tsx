import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ApiError, StaleRequestError } from "../src/api/client";
import { useT } from "../src/i18n/provider";
import { parseInbox } from "../src/home/inbox";
import { useSession } from "../src/state/session";
import { LoadingScreen, ScreenMessage } from "../src/ui/screen";
import { PanelHeader } from "../src/ui/PanelHeader";
import { AppText } from "../src/ui/text";
import { color } from "../src/ui/tokens";

export default function ActivityScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const [rows, setRows] = useState<ReturnType<typeof parseInbox>["rows"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await session.client.get<unknown>("/channels/inbox?limit=50");
      setRows(parseInbox(data).rows);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setError(caught instanceof ApiError ? caught.message : t("mobile.channels.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [session.client, t]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  return (
    <View style={styles.page}>
      <PanelHeader title={t("layout.sidebar.activity")} onBack={() => router.back()} />
      {loading ? <LoadingScreen /> : error ? <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} /> : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          ListEmptyComponent={<AppText style={styles.empty}>{t("thread.empty.defaultTitle")}</AppText>}
          renderItem={({ item }) => (
            <Pressable onPress={() => {
              if (item.kind === "thread") {
                router.push({
                  pathname: "/thread/[threadId]",
                  params: {
                    threadId: item.channelId,
                    parentChannelId: item.parentChannelId ?? "",
                    parentMessageId: item.parentMessageId ?? "",
                    title: t("message.threadPanel.thread"),
                  },
                });
                return;
              }
              router.push({ pathname: "/messages/[channelId]", params: { channelId: item.channelId, name: item.channelName } });
            }} style={styles.row}>
              <AppText style={styles.title}>{item.title}</AppText>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  title: { color: color.ink, fontSize: 14 },
  empty: { color: color.muted, padding: 16, textAlign: "center" },
});
