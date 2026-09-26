import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { CheckSquare } from "lucide-react-native";
import * as SecureStore from "expo-secure-store";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../../src/i18n/provider";
import { parseChannels } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { useServerRole } from "../../src/home/serverRole";
import {
  channelChoices,
  defaultCollapsed,
  EMPTY_TASK_FILTERS,
  filteredTaskGroups,
  filterTasks,
  hasTaskFilter,
  parseTaskFilters,
  peopleChoices,
  toggleChoice,
  UNASSIGNED,
  type FilterChoice,
  type TaskFilters,
} from "../../src/tasks/list";
import { FilterSheet, TaskCardView, TaskEmptyGroup, TaskFilterChip, TaskGroupHeader, TaskSkeleton } from "../../src/tasks/TasksView";
import { useTaskStore } from "../../src/tasks/store";
import type { TaskStatus } from "../../src/tasks/model";
import { ScreenMessage } from "../../src/ui/screen";
import { PanelHeader } from "../../src/ui/PanelHeader";
import { AppText } from "../../src/ui/text";
import { border, color } from "../../src/ui/tokens";

type SheetKind = "channel" | "creator" | "assignee";

function filterKey(serverId: string): string {
  return `raft.taskFilters.${serverId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

export default function TasksScreen() {
  const router = useRouter();
  const session = useSession();
  const role = useServerRole();
  const t = useT();
  const insets = useSafeAreaInsets();
  const tasks = useTaskStore((state) => state.tasks);
  const loading = useTaskStore((state) => state.loading);
  const loaded = useTaskStore((state) => state.loaded);
  const error = useTaskStore((state) => state.error);
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_TASK_FILTERS);
  const [channels, setChannels] = useState<FilterChoice[]>([]);
  const [people, setPeople] = useState<FilterChoice[]>([]);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(useCallback(() => {
    useTaskStore.getState().setVisible(true);
    if (!useTaskStore.getState().loaded) void useTaskStore.getState().load(session.client);
    return () => useTaskStore.getState().setVisible(false);
  }, [session.client, session.serverId]));

  useEffect(() => {
    const serverId = session.serverId;
    if (!serverId) return;
    let cancelled = false;
    void SecureStore.getItemAsync(filterKey(serverId)).then((raw) => {
      if (!cancelled) setFilters(parseTaskFilters(raw));
    }).catch(() => undefined);
    void Promise.all([
      session.client.get<unknown>("/channels?archived=exclude").catch(() => null),
      session.client.get<unknown>("/agents").catch(() => null),
      session.client.get<unknown>(`/servers/${serverId}/members`).catch(() => null),
    ]).then(([channelData, agents, members]) => {
      if (cancelled) return;
      setChannels(channelChoices(parseChannels(channelData), useTaskStore.getState().tasks));
      setPeople(peopleChoices(agents, members));
    });
    return () => {
      cancelled = true;
    };
  }, [session.client, session.serverId]);

  useEffect(() => {
    setChannels((current) => channelChoices(current.map((choice) => ({ id: choice.id, name: choice.label, type: "channel" as const })), tasks));
  }, [tasks]);

  const updateFilters = (next: TaskFilters) => {
    setFilters(next);
    const serverId = session.serverId;
    if (!serverId) return;
    void SecureStore.setItemAsync(filterKey(serverId), JSON.stringify(next)).catch(() => undefined);
  };

  const filtered = filterTasks(tasks, filters);
  const groups = filteredTaskGroups(tasks, filters);
  const filtering = hasTaskFilter(filters);
  const subtitle = `${filtered.length}${filtering ? t("task.panel.ofTotal", { total: tasks.length }) : ""} ${t("task.panel.channelTasks")}`;
  const userKey = session.user?.id ? `user:${session.user.id}` : null;
  const pinned: FilterChoice[] = sheet === "creator" && userKey
    ? [{ id: userKey, label: t("task.filter.createdByMe") }]
    : sheet === "assignee"
      ? [
        ...(userKey ? [{ id: userKey, label: t("task.filter.assignedToMe") }] : []),
        { id: UNASSIGNED, label: t("task.filter.unassigned"), italic: true },
      ]
      : [];
  const sheetChoices = sheet === "channel" ? channels : people;
  const selected = sheet === "channel" ? filters.channels : sheet === "creator" ? filters.creators : filters.assignees;

  const refresh = async () => {
    setRefreshing(true);
    await useTaskStore.getState().load(session.client);
    setRefreshing(false);
  };

  return (
    <View style={styles.page}>
      <PanelHeader subtitle={subtitle} title={t("task.panel.heading")} tone="yellow" />
      <View style={styles.toolbar}>
        <TaskFilterChip count={filters.channels.length} icon="channel" label={t("task.filter.channels")} onPress={() => setSheet("channel")} />
        <TaskFilterChip count={filters.creators.length} icon="creator" label={t("task.filter.creator")} onPress={() => setSheet("creator")} />
        <TaskFilterChip count={filters.assignees.length} icon="assignee" label={t("task.filter.assignee")} onPress={() => setSheet("assignee")} />
        {filtering ? (
          <Pressable accessibilityRole="button" onPress={() => updateFilters(EMPTY_TASK_FILTERS)}>
            <AppText style={styles.clear}>{t("task.panel.clearAll")}</AppText>
          </Pressable>
        ) : null}
      </View>
      {error && loaded ? <AppText style={styles.error}>{error}</AppText> : null}
      {loading && !loaded ? (
        <View style={styles.list}>
          {Array.from({ length: 5 }, (_, index) => <TaskSkeleton key={index} />)}
        </View>
      ) : error && !loaded ? (
        <ScreenMessage body={error} title={t("mobile.channels.loadFailed")} />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }, filtered.length === 0 ? styles.listEmpty : null]}
          refreshControl={<RefreshControl colors={[color.ink]} onRefresh={() => void refresh()} refreshing={refreshing} tintColor={color.ink} />}
        >
          {filtered.length === 0 ? (
            <View style={styles.empty}>
              <CheckSquare color={color.ink} size={36} strokeWidth={2.25} />
              <AppText style={styles.emptyTitle}>{t(filtering ? "emptyState.noTasksFiltered" : "emptyState.noTasksTitle")}</AppText>
              <AppText style={styles.emptyBody}>{t(filtering ? "task.filter.noMatchHint" : "task.panel.serverWideExcluded")}</AppText>
            </View>
          ) : groups.map((group) => (
            <View key={group.status} style={styles.group}>
              <TaskGroupHeader
                collapsed={collapsed[group.status]}
                count={group.tasks.length}
                onPress={() => setCollapsed((current) => ({ ...current, [group.status]: !current[group.status] }))}
                status={group.status}
              />
              {collapsed[group.status] ? null : group.tasks.length === 0 ? (
                <TaskEmptyGroup status={group.status} />
              ) : group.tasks.map((task) => (
                <TaskCardView
                  key={task.id}
                  onOpen={() => router.push({ pathname: "/task/[taskId]", params: { taskId: task.id } })}
                  onStatus={(status: TaskStatus) => void useTaskStore.getState().setStatus(session.client, task.id, status)}
                  role={role}
                  task={task}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
      {sheet ? (
        <FilterSheet
          choices={sheetChoices}
          onClose={() => setSheet(null)}
          onToggle={(id) => updateFilters({
            ...filters,
            channels: sheet === "channel" ? toggleChoice(filters.channels, id) : filters.channels,
            creators: sheet === "creator" ? toggleChoice(filters.creators, id) : filters.creators,
            assignees: sheet === "assignee" ? toggleChoice(filters.assignees, id) : filters.assignees,
          })}
          pinned={pinned}
          selected={selected}
          title={t(sheet === "channel" ? "task.filter.channels" : sheet === "creator" ? "task.filter.creator" : "task.filter.assignee")}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  toolbar: {
    alignItems: "center",
    borderBottomColor: color.border,
    borderBottomWidth: border.strong,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  clear: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16, textDecorationLine: "underline" },
  error: { color: color.red, fontSize: 12, lineHeight: 16, paddingHorizontal: 16, paddingTop: 8 },
  list: { padding: 16 },
  listEmpty: { flexGrow: 1 },
  group: { gap: 10, marginBottom: 24 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center", paddingHorizontal: 24, paddingVertical: 48 },
  emptyTitle: { color: color.ink, fontSize: 18, fontWeight: "600", lineHeight: 24, marginTop: 12, textAlign: "center" },
  emptyBody: { color: color.muted, fontSize: 14, lineHeight: 20, marginTop: 4, textAlign: "center" },
});
