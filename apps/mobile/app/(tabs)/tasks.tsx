import { useCallback } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useT } from "../../src/i18n/provider";
import { useSession } from "../../src/state/session";
import { groupTasks } from "../../src/tasks/model";
import { useTaskStore } from "../../src/tasks/store";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";
import { PanelHeader } from "../../src/ui/PanelHeader";
import { AppText } from "../../src/ui/text";
import { color, fontSize } from "../../src/ui/tokens";

const STATUS_LABEL = {
  todo: "task.status.todo",
  in_progress: "task.status.inProgress",
  in_review: "task.status.inReview",
  done: "task.status.done",
  closed: "task.status.closed",
} as const;

export default function TasksScreen() {
  const session = useSession();
  const router = useRouter();
  const t = useT();
  const tasks = useTaskStore((state) => state.tasks);
  const loading = useTaskStore((state) => state.loading);
  const loaded = useTaskStore((state) => state.loaded);
  const error = useTaskStore((state) => state.error);

  useFocusEffect(useCallback(() => {
    useTaskStore.getState().setVisible(true);
    if (!useTaskStore.getState().loaded) void useTaskStore.getState().load(session.client);
    return () => useTaskStore.getState().setVisible(false);
  }, [session.client, session.serverId]));

  if (loading && !loaded) return <LoadingScreen />;
  if (error && !loaded) return <ScreenMessage title={t("mobile.channels.loadFailed")} body={error} />;

  const groups = groupTasks(tasks).filter((group) => group.tasks.length > 0);

  return (
    <View style={styles.page}>
      <PanelHeader
        tone="yellow"
        title={t("layout.mobileTabBar.tasks")}
        subtitle={`${tasks.length} ${t("task.panel.channelTasks")}`}
      />
      {error ? <AppText style={styles.error}>{error}</AppText> : null}
      <FlatList
        data={groups}
        keyExtractor={(group) => group.status}
        renderItem={({ item }) => (
          <View>
            <AppText style={styles.section}>{t(STATUS_LABEL[item.status])}</AppText>
            {item.tasks.map((task) => (
              <Pressable key={task.id} onPress={() => router.push({ pathname: "/messages/[channelId]", params: { channelId: task.channelId, name: task.channelName ?? "", messageId: task.id } })} style={styles.row}>
                <AppText style={styles.title}>{`#${task.taskNumber} ${task.title}`}</AppText>
              </Pressable>
            ))}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  error: { ...fontSize.time, color: color.red, paddingHorizontal: 16, paddingTop: 8 },
  section: { ...fontSize.group, color: color.ink, fontWeight: "700", letterSpacing: 0.8, paddingHorizontal: 16, paddingTop: 16, textTransform: "uppercase" },
  row: { borderColor: "transparent", borderWidth: 2, justifyContent: "center", marginBottom: 4, paddingHorizontal: 16, paddingVertical: 8 },
  title: { ...fontSize.list, color: color.ink, fontWeight: "700" },
});
