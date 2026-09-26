import { useCallback } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { activityKey, activityTitle } from "../src/activity/model";
import { useActivityStore } from "../src/activity/store";
import { useT } from "../src/i18n/provider";
import { useSession } from "../src/state/session";
import { LoadingScreen, ScreenMessage } from "../src/ui/screen";
import { PanelHeader } from "../src/ui/PanelHeader";
import { AppText } from "../src/ui/text";
import { color, fontSize } from "../src/ui/tokens";

export default function ActivityScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const rows = useActivityStore((state) => state.items);
  const loading = useActivityStore((state) => state.loading);
  const error = useActivityStore((state) => state.error);

  useFocusEffect(useCallback(() => {
    void useActivityStore.getState().load(session.client, "all");
  }, [session.client]));

  return (
    <View style={styles.page}>
      <PanelHeader title={t("layout.sidebar.activity")} onBack={() => router.back()} />
      {loading ? <LoadingScreen /> : error ? <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} /> : (
        <FlatList
          data={rows}
          keyExtractor={(row) => activityKey(row)}
          ListEmptyComponent={<AppText style={styles.empty}>{t("thread.empty.defaultTitle")}</AppText>}
          renderItem={({ item }) => (
            <Pressable onPress={() => {
              if (item.kind === "thread") {
                router.push({
                  pathname: "/thread/[threadId]",
                  params: {
                    threadId: item.threadChannelId,
                    parentChannelId: item.parentChannelId,
                    parentMessageId: item.parentMessageId,
                    title: t("message.threadPanel.thread"),
                  },
                });
                return;
              }
              router.push({ pathname: "/messages/[channelId]", params: { channelId: item.channelId, name: item.channelName } });
            }} style={styles.row}>
              <AppText style={styles.title}>{activityTitle(item)}</AppText>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  row: { borderColor: "transparent", borderWidth: 2, justifyContent: "center", marginBottom: 4, paddingHorizontal: 16, paddingVertical: 8 },
  title: { ...fontSize.list, color: color.ink, fontWeight: "500" },
  empty: { color: color.muted, padding: 16, textAlign: "center" },
});
