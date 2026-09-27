import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { CheckSquare, SlidersHorizontal } from "lucide-react-native";
import * as SecureStore from "expo-secure-store";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../../src/i18n/provider";
import { parseChannels, isRecord } from "../../src/model/messages";
import { useSession } from "../../src/state/session";
import { useServerRole } from "../../src/home/serverRole";
import {
  channelChoices,
  EMPTY_TASK_FILTERS,
  filterTasks,
  hasTaskFilter,
  parseTaskFilters,
  peopleChoices,
  toggleChoice,
  UNASSIGNED,
  type FilterChoice,
  type TaskFilters,
} from "../../src/tasks/list";
import { FilterSheet, TaskFilterChip, TaskSkeleton } from "../../src/tasks/TasksView";
import { useBoardStore, BOARD_TICK_MS } from "../../src/tasks/boardStore";
import { buildBoard, canApproveFrom, BOARD_SECTIONS } from "../../src/tasks/board";
import { BoardSectionHeader } from "../../src/tasks/BoardSectionHeader";
import { BoardTaskRow, type BoardAssigneeInfo } from "../../src/tasks/BoardTaskRow";
import { ScreenMessage } from "../../src/ui/screen";
import { PanelHeader } from "../../src/ui/PanelHeader";
import { AppText } from "../../src/ui/text";
import { border, color } from "../../src/ui/tokens";

type SheetKind = "channel" | "creator" | "assignee";

function filterKey(serverId: string): string {
  return `raft.taskFilters.${serverId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

interface AgentPresence {
  avatarUrl: string | null;
  status: NonNullable<BoardAssigneeInfo["status"]>;
}

/** Live /agents rows keyed by agent id — feeds the rows' presence dots. */
function agentPresence(data: unknown): Map<string, AgentPresence> {
  const map = new Map<string, AgentPresence>();
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.agents) ? data.agents : [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== "string" || item.deletedAt) continue;
    map.set(item.id, { avatarUrl: typeof item.avatarUrl === "string" ? item.avatarUrl : null, status: agentStatusOf(item) });
  }
  return map;
}

function agentStatusOf(item: Record<string, unknown>): AgentPresence["status"] {
  const value = (typeof item.activity === "string" ? item.activity : "") || (typeof item.status === "string" ? item.status : "");
  if (value === "error") return "error";
  if (value === "busy" || value === "working" || value === "running") return "busy";
  if (value === "online" || value === "idle") return "online";
  return "offline";
}

export default function TasksScreen() {
  const router = useRouter();
  const session = useSession();
  const role = useServerRole();
  const t = useT();
  const insets = useSafeAreaInsets();
  const tasks = useBoardStore((state) => state.tasks);
  const loading = useBoardStore((state) => state.loading);
  const loaded = useBoardStore((state) => state.loaded);
  const error = useBoardStore((state) => state.error);
  const tick = useBoardStore((state) => state.tick);
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_TASK_FILTERS);
  const [channels, setChannels] = useState<FilterChoice[]>([]);
  const [people, setPeople] = useState<FilterChoice[]>([]);
  const [presence, setPresence] = useState<Map<string, AgentPresence>>(() => new Map());
  const [todoCollapsed, setTodoCollapsed] = useState(true);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [filterMenu, setFilterMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(useCallback(() => {
    if (!useBoardStore.getState().loaded) void useBoardStore.getState().load(session.client);
    return () => undefined;
  }, [session.client]));

  // Per-minute tick: rows recompute relative times and staleness; a calendar-day
  // rollover reloads the board with the new midnight as completedAfter.
  useEffect(() => {
    const interval = setInterval(() => useBoardStore.getState().bumpTick(session.client), BOARD_TICK_MS);
    return () => clearInterval(interval);
  }, [session.client]);

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
      setChannels(channelChoices(parseChannels(channelData), useBoardStore.getState().tasks));
      setPeople(peopleChoices(agents, members));
      setPresence(agentPresence(agents));
    });
    return () => {
      cancelled = true;
    };
  }, [session.client, session.serverId]);

  const updateFilters = (next: TaskFilters) => {
    setFilters(next);
    const serverId = session.serverId;
    if (!serverId) return;
    void SecureStore.setItemAsync(filterKey(serverId), JSON.stringify(next)).catch(() => undefined);
  };

  const filtered = filterTasks(tasks, filters);
  const filtering = hasTaskFilter(filters);
  const board = useMemo(() => buildBoard(filtered, new Date()), [filtered, tick]);
  const activeFilterCount = filters.channels.length + filters.creators.length + filters.assignees.length;
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
  const client = session.client;

  const approve = async (taskId: string) => {
    const ok = await useBoardStore.getState().approveTask(client, taskId);
    if (!ok) Alert.alert(t("mobile.board.approveFailed"));
  };

  const refresh = async () => {
    setRefreshing(true);
    await useBoardStore.getState().load(client);
    setRefreshing(false);
  };

  const filterButton = (
    <Pressable accessibilityRole="button" onPress={() => setFilterMenu(true)} style={styles.filterButton}>
      <SlidersHorizontal color={activeFilterCount > 0 ? color.ink : color.inkLabel} size={16} strokeWidth={2.5} />
      {activeFilterCount > 0 ? <AppText style={styles.filterCount}>{String(activeFilterCount)}</AppText> : null}
    </Pressable>
  );

  const sections = BOARD_SECTIONS.map((section) => ({ section, rows: board[section] }));

  return (
    <View style={styles.page}>
      <PanelHeader actions={filterButton} subtitle={subtitle} title={t("task.panel.heading")} tone="yellow" />
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
          ) : sections.map(({ section, rows }) => (
            <View key={section} style={styles.group}>
              {section !== "todo" || rows.length > 0 ? (
                <BoardSectionHeader
                  collapsed={todoCollapsed}
                  count={rows.length}
                  onPress={section === "todo" ? () => setTodoCollapsed((current) => !current) : undefined}
                  section={section}
                />
              ) : null}
              {section === "todo" && todoCollapsed
                ? null
                : rows.map((row) => (
                  <BoardTaskRow
                    assignee={assigneeInfoOf(row.task, presence)}
                    key={row.task.id}
                    onApprove={section === "needsMe" && canApproveFrom(row.task.status, role)
                      ? () => void approve(row.task.id)
                      : undefined}
                    onPress={() => router.push({ pathname: "/task/[taskId]", params: { taskId: row.task.id } })}
                    row={row}
                  />
                ))}
            </View>
          ))}
        </ScrollView>
      )}
      {filterMenu ? (
        <FilterMenu
          filters={filters}
          onClose={() => setFilterMenu(false)}
          onClear={() => updateFilters(EMPTY_TASK_FILTERS)}
          onOpenSheet={setSheet}
        />
      ) : null}
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

function FilterMenu({
  filters,
  onClose,
  onClear,
  onOpenSheet,
}: {
  filters: TaskFilters;
  onClose: () => void;
  onClear: () => void;
  onOpenSheet: (kind: SheetKind) => void;
}) {
  const t = useT();
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.scrim} />
      <View style={styles.filterMenu}>
        <TaskFilterChip count={filters.channels.length} icon="channel" label={t("task.filter.channels")} onPress={() => onOpenSheet("channel")} />
        <TaskFilterChip count={filters.creators.length} icon="creator" label={t("task.filter.creator")} onPress={() => onOpenSheet("creator")} />
        <TaskFilterChip count={filters.assignees.length} icon="assignee" label={t("task.filter.assignee")} onPress={() => onOpenSheet("assignee")} />
        {hasTaskFilter(filters) ? (
          <Pressable accessibilityRole="button" onPress={onClear}>
            <AppText style={styles.clear}>{t("task.panel.clearAll")}</AppText>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

function assigneeInfoOf(task: { claimedByType: string | null; claimedById: string | null }, presence: Map<string, AgentPresence>): BoardAssigneeInfo | null {
  if (task.claimedByType !== "agent" || !task.claimedById) return null;
  return presence.get(task.claimedById) ?? null;
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  filterButton: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  filterCount: { color: color.ink, fontFamily: "mono", fontSize: 11, fontWeight: "700", lineHeight: 14 },
  filterMenu: { backgroundColor: color.page, borderColor: color.border, borderTopWidth: border.strong, flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  scrim: { backgroundColor: color.scrim, flex: 1 },
  clear: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16, textDecorationLine: "underline" },
  error: { color: color.red, fontSize: 12, lineHeight: 16, paddingHorizontal: 16, paddingTop: 8 },
  list: { padding: 16 },
  listEmpty: { flexGrow: 1 },
  group: { gap: 10, marginBottom: 24 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center", paddingHorizontal: 24, paddingVertical: 48 },
  emptyTitle: { color: color.ink, fontSize: 18, fontWeight: "600", lineHeight: 24, marginTop: 12, textAlign: "center" },
  emptyBody: { color: color.muted, fontSize: 14, lineHeight: 20, marginTop: 4, textAlign: "center" },
});
