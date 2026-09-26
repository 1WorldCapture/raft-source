import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { useT } from "../../src/i18n/provider";
import { isRecord } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";
import { PanelHeader } from "../../src/ui/PanelHeader";
import { AppText } from "../../src/ui/text";
import { color, fontSize } from "../../src/ui/tokens";

const ORDER = ["todo", "in_progress", "in_review", "done", "closed"] as const;

const STATUS_LABEL = {
  todo: "task.status.todo",
  in_progress: "task.status.inProgress",
  in_review: "task.status.inReview",
  done: "task.status.done",
  closed: "task.status.closed",
} as const;

interface TaskRow {
  id: string;
  title: string;
  status: string;
  taskNumber: number;
  channelId: string;
  channelName: string;
}

export default function TasksScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await session.client.get<unknown>("/tasks/server?detail=summary");
      setTasks(parseTasks(data));
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

  if (loading) return <LoadingScreen />;
  if (error) return <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} />;

  const groups = ORDER.map((status) => ({ status, rows: tasks.filter((task) => task.status === status) })).filter((group) => group.rows.length > 0);

  return (
    <View style={styles.page}>
      <PanelHeader title={t("layout.mobileTabBar.tasks")} />
      <FlatList
        data={groups}
        keyExtractor={(group) => group.status}
        renderItem={({ item }) => (
          <View>
            <AppText style={styles.section}>{t(STATUS_LABEL[item.status])}</AppText>
            {item.rows.map((task) => (
              <Pressable key={task.id} onPress={() => router.push({ pathname: "/messages/[channelId]", params: { channelId: task.channelId, name: task.channelName, messageId: task.id } })} style={styles.row}>
                <AppText style={styles.title}>{`#${task.taskNumber} ${task.title}`}</AppText>
              </Pressable>
            ))}
          </View>
        )}
      />
    </View>
  );
}

function parseTasks(data: unknown): TaskRow[] {
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.tasks) ? data.tasks : [];
  return list.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.channelId !== "string") return [];
    return [{
      id: item.id,
      title: typeof item.title === "string" ? item.title : "",
      status: typeof item.status === "string" ? item.status : "todo",
      taskNumber: typeof item.taskNumber === "number" ? item.taskNumber : 0,
      channelId: item.channelId,
      channelName: typeof item.channelName === "string" ? item.channelName : "",
    }];
  });
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  section: { ...fontSize.group, color: color.ink, fontWeight: "700", letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 16, textTransform: "uppercase" },
  row: { borderColor: "transparent", borderWidth: 2, justifyContent: "center", marginBottom: 4, paddingHorizontal: 16, paddingVertical: 8 },
  title: { ...fontSize.list, color: color.ink, fontWeight: "700" },
});
