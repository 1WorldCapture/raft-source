import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ApiError, StaleRequestError } from "../src/api/client";
import { useT } from "../src/i18n/provider";
import { isRecord } from "../src/model/messages";
import { useSession } from "../src/state/session";
import { LoadingScreen, ScreenMessage } from "../src/ui/screen";
import { PanelHeader } from "../src/ui/PanelHeader";
import { AppText } from "../src/ui/text";
import { color } from "../src/ui/tokens";

interface ActivityRow {
  id: string;
  title: string;
  channelId: string | null;
  channelName: string;
}

export default function ActivityScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await session.client.get<unknown>("/channels/inbox?limit=50");
      setRows(parseActivity(data));
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
            <Pressable disabled={!item.channelId} onPress={() => item.channelId && router.push({ pathname: "/messages/[channelId]", params: { channelId: item.channelId, name: item.channelName } })} style={styles.row}>
              <AppText style={styles.title}>{item.title}</AppText>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function parseActivity(data: unknown): ActivityRow[] {
  const list = isRecord(data) && Array.isArray(data.items) ? data.items : [];
  return list.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const id = typeof item.id === "string" ? item.id : String(index);
    const title = typeof item.title === "string" ? item.title : typeof item.preview === "string" ? item.preview : id;
    const channelId = typeof item.channelId === "string" ? item.channelId : null;
    const channelName = typeof item.channelName === "string" ? item.channelName : "";
    return [{ id, title, channelId, channelName }];
  });
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  row: { paddingHorizontal: 16, paddingVertical: 12 },
  title: { color: color.ink, fontSize: 14 },
  empty: { color: color.muted, padding: 16, textAlign: "center" },
});
