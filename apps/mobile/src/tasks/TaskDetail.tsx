import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react-native";
import type { AppMessageId } from "../i18n/catalog";
import { useT } from "../i18n/provider";
import { formatMessageStamp } from "../screens/messageTime";
import { AppText } from "../ui/text";
import { border, color } from "../ui/tokens";
import {
  historyPointStatus,
  historyStatusChange,
  historyTitleId,
  matchingPeople,
  type AssigneePerson,
  type TaskHistoryEvent,
} from "./history";
import { channelLabel } from "./list";
import { taskStatusOptions, type RaftTask, type TaskAssignee, type TaskStatus } from "./model";
import { TaskStatusButton } from "./TasksView";

export function TaskDetailView({
  task,
  role,
  history,
  historyError,
  people,
  notice,
  timeZone,
  hour12,
  onBack,
  onStatus,
  onAssignee,
  fill,
}: {
  task: RaftTask;
  role: string | null;
  history: readonly TaskHistoryEvent[];
  historyError: boolean;
  people: readonly AssigneePerson[];
  notice: string | null;
  timeZone?: string;
  hour12?: boolean;
  onBack: () => void;
  onStatus: (status: TaskStatus) => void;
  onAssignee: (assignee: TaskAssignee | null) => void;
  /** Legacy tasks have no thread, so the head uses the rest of the screen. */
  fill?: boolean;
}) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const description = task.description?.trim() ?? "";
  const collapsible = lineCount > 3;
  const assignee = personLabel(people, task.claimedByType, task.claimedById, task.claimedByName, t("task.properties.unassigned"), t("task.properties.unknown"));
  const creator = personLabel(people, task.createdByType, task.createdById, task.createdByName, t("task.properties.unknown"), t("task.properties.unknown"));
  const guest = taskStatusOptions(task.status, role).length === 0;
  return (
    <View style={[styles.page, fill ? styles.pageFill : null]}>
      <View style={[styles.bar, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityLabel={t("task.modal.close")} accessibilityRole="button" onPress={onBack} style={styles.back}>
          <ArrowLeft color={color.ink} size={14} strokeWidth={2.5} />
        </Pressable>
        <View style={styles.barText}>
          <AppText numberOfLines={1} style={styles.channel}>{channelLabel(task.channelName || t("task.properties.unknownChannel"))}</AppText>
          <AppText numberOfLines={1} style={styles.taskLabel}>{t("task.modal.taskWithNumber", { taskNumber: task.taskNumber })}</AppText>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <AppText numberOfLines={3} style={styles.title}>{task.title}</AppText>
        {description ? (
          <View style={styles.descriptionBlock}>
            <AppText
              numberOfLines={expanded ? undefined : 3}
              onTextLayout={(event) => setLineCount((current) => Math.max(current, event.nativeEvent.lines.length))}
              style={styles.description}
            >
              {description}
            </AppText>
            {collapsible ? (
              <Pressable accessibilityRole="button" onPress={() => setExpanded((current) => !current)}>
                <AppText style={styles.more}>{expanded ? t("message.content.collapse") : t("message.content.showMore")}</AppText>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => setHistoryOpen((current) => !current)} style={styles.historyToggle}>
          <AppText style={styles.historyLabel}>{t("task.properties.history")}</AppText>
          {historyOpen ? <ChevronDown color={color.ink} size={14} strokeWidth={2.5} /> : <ChevronRight color={color.ink} size={14} strokeWidth={2.5} />}
        </Pressable>
        {historyOpen ? (
          <HistoryList
            error={historyError}
            events={history}
            hour12={hour12}
            people={people}
            timeZone={timeZone}
          />
        ) : null}
        <View style={styles.properties}>
          <Property label={t("task.properties.status")}>
            <TaskStatusButton onStatus={onStatus} role={role} status={task.status} />
          </Property>
          <Property label={t("task.properties.assignee")}>
            {guest ? <AppText style={styles.fact}>{assignee}</AppText> : (
              <Pressable accessibilityRole="button" onPress={() => setAssigneeOpen(true)} style={styles.assignee}>
                <AppText numberOfLines={1} style={styles.assigneeText}>{assignee}</AppText>
              </Pressable>
            )}
          </Property>
          <Property label={t("task.properties.createdBy")}>
            <AppText numberOfLines={1} style={styles.fact}>{creator}</AppText>
          </Property>
        </View>
        {notice ? <AppText style={styles.notice}>{notice}</AppText> : null}
      </ScrollView>
      {assigneeOpen ? (
        <AssigneeSheet
          currentId={task.claimedByType && task.claimedById ? `${task.claimedByType}:${task.claimedById}` : "unassign"}
          onClose={() => setAssigneeOpen(false)}
          onSelect={(person) => {
            setAssigneeOpen(false);
            onAssignee(person);
          }}
          people={people}
        />
      ) : null}
    </View>
  );
}

function HistoryList({
  events,
  error,
  people,
  timeZone,
  hour12,
}: {
  events: readonly TaskHistoryEvent[];
  error: boolean;
  people: readonly AssigneePerson[];
  timeZone?: string;
  hour12?: boolean;
}) {
  const t = useT();
  if (error) return <AppText style={styles.notice}>{t("task.history.error")}</AppText>;
  if (events.length === 0) return <AppText style={styles.emptyHistory}>{t("task.history.empty")}</AppText>;
  return (
    <View style={styles.timeline}>
      {events.map((event, index) => {
        const point = historyPointStatus(event);
        const change = historyStatusChange(event);
        const titleId = historyTitleId(event.eventType);
        const when = event.createdAt
          ? formatMessageStamp(event.createdAt, { now: new Date(), hour12, timeZone, yesterdayLabel: t("message.dateDivider.yesterday") })
          : "";
        return (
          <View key={event.id} style={styles.event}>
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: point ? fill(point) : color.border }]} />
              {index < events.length - 1 ? <View style={[styles.line, { backgroundColor: point ? fill(point) : color.borderFaint }]} /> : null}
            </View>
            <View style={styles.eventBody}>
              <AppText style={styles.eventTitle}>{titleId ? t(titleId) : event.eventType}</AppText>
              <AppText style={styles.eventMeta}>{`${event.actorName ?? event.actorType}${when ? ` · ${when}` : ""}`}</AppText>
              {change ? (
                <View style={styles.transition}>
                  <StatusChip status={change.from} />
                  <AppText style={styles.arrow}>→</AppText>
                  <StatusChip status={change.to} />
                </View>
              ) : <AppText style={styles.eventDetail}>{detailText(event, people, t)}</AppText>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function StatusChip({ status }: { status: TaskStatus }) {
  const t = useT();
  return (
    <View style={[styles.chip, { backgroundColor: fill(status) }]}>
      <AppText style={styles.chipText}>{t(statusLabel(status))}</AppText>
    </View>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.property}>
      <AppText style={styles.propertyLabel}>{label}</AppText>
      {children}
    </View>
  );
}

function AssigneeSheet({
  people,
  currentId,
  onClose,
  onSelect,
}: {
  people: readonly AssigneePerson[];
  currentId: string;
  onClose: () => void;
  onSelect: (assignee: TaskAssignee | null) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const shown = matchingPeople(people, query);
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <View style={styles.modal}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.scrim} />
        <View style={styles.sheet}>
          <AppText style={styles.sheetTitle}>{t("task.properties.assignee")}</AppText>
          <TextInput
            onChangeText={setQuery}
            placeholder={t("task.assignee.searchPlaceholder")}
            placeholderTextColor={color.muted}
            style={styles.search}
            value={query}
          />
          <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetList}>
            <Pressable onPress={() => onSelect(null)} style={styles.choice}>
              <AppText style={styles.italic}>{t("task.properties.unassigned")}</AppText>
            </Pressable>
            {shown.map((person) => (
              <Pressable key={`${person.type}:${person.id}`} onPress={() => onSelect({ type: person.type, id: person.id })} style={styles.choice}>
                <AppText style={[styles.choiceLabel, currentId === `${person.type}:${person.id}` ? styles.choiceOn : null]}>{person.label}</AppText>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function personLabel(
  people: readonly AssigneePerson[],
  type: string | null,
  id: string | null,
  fallback: string | null,
  empty: string,
  unknown: string,
): string {
  if (!type || !id) return empty;
  const found = people.find((person) => person.type === type && person.id === id);
  if (found) return found.label;
  return fallback ? `@${fallback.replace(/^@/, "")}` : unknown;
}

function detailText(event: TaskHistoryEvent, people: readonly AssigneePerson[], t: (id: AppMessageId, values?: Record<string, string | number>) => string): string {
  const payload = event.payload;
  if (event.eventType === "created") {
    const status = isStatus(payload.status) ? payload.status : "todo";
    return t("task.history.createdDetail", { taskNumber: String(payload.taskNumber ?? "—"), status: t(statusLabel(status)) });
  }
  if (event.eventType === "assignee_changed") {
    if (!payload.assigneeId) return t("task.history.detail.unassigned");
    const type = payload.assigneeType === "agent" ? "agent" : "user";
    const name = personLabel(people, type, String(payload.assigneeId), null, t("task.properties.unknown"), t("task.properties.unknown"));
    return t("task.history.assignedTo", { name });
  }
  if (event.eventType === "amended" && isRecord(payload.changes)) {
    return Object.entries(payload.changes).map(([key, value]) => {
      const field = key === "title" ? t("task.history.field.title") : key === "description" ? t("task.history.field.description") : key;
      const change = isRecord(value) ? value : {};
      return t("task.history.detail.fieldChange", {
        field,
        from: String(change.from ?? "—"),
        to: String(change.to ?? (typeof value === "string" ? value : "—")),
      });
    }).join(" · ");
  }
  return "";
}

function fill(status: TaskStatus): string {
  if (status === "in_progress") return color.cyan;
  if (status === "in_review") return color.lavender;
  if (status === "done") return color.lime;
  if (status === "closed") return color.stone;
  return color.orange;
}

function statusLabel(status: TaskStatus): AppMessageId {
  if (status === "in_progress") return "task.status.inProgress";
  if (status === "in_review") return "task.status.inReview";
  if (status === "done") return "task.status.done";
  if (status === "closed") return "task.status.closed";
  return "task.status.todo";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is TaskStatus {
  return value === "todo" || value === "in_progress" || value === "in_review" || value === "done" || value === "closed";
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flexShrink: 0, maxHeight: "48%" },
  pageFill: { flex: 1, maxHeight: "100%" },
  bar: {
    alignItems: "center",
    backgroundColor: color.page,
    borderBottomColor: color.border,
    borderBottomWidth: border.strong,
    flexDirection: "row",
    gap: 12,
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  back: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  barText: { flex: 1, minWidth: 0 },
  channel: { color: color.inkMid, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  taskLabel: { color: color.ink, fontSize: 14, fontWeight: "700", lineHeight: 18 },
  body: { paddingBottom: 12, paddingHorizontal: 16, paddingTop: 12 },
  title: { color: color.ink, fontSize: 18, fontWeight: "700", lineHeight: 24 },
  descriptionBlock: { marginTop: 8 },
  description: { color: color.inkLabel, fontSize: 14, lineHeight: 20 },
  more: { color: color.ink, fontSize: 12, fontWeight: "700", marginTop: 4 },
  historyToggle: { alignItems: "center", borderBottomColor: color.borderFaint, borderBottomWidth: border.hairline, flexDirection: "row", gap: 4, marginTop: 16, paddingBottom: 8 },
  historyLabel: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  emptyHistory: { color: color.muted, fontSize: 12, lineHeight: 16, marginTop: 8 },
  timeline: { marginTop: 8 },
  event: { flexDirection: "row", gap: 8 },
  rail: { alignItems: "center", width: 12 },
  dot: { borderRadius: 4, height: 8, marginTop: 4, width: 8 },
  line: { flex: 1, width: 2 },
  eventBody: { flex: 1, paddingBottom: 10 },
  eventTitle: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  eventMeta: { color: color.muted, fontSize: 11, lineHeight: 14 },
  eventDetail: { color: color.inkMid, fontSize: 12, lineHeight: 16, marginTop: 2 },
  transition: { alignItems: "center", flexDirection: "row", gap: 4, marginTop: 4 },
  arrow: { color: color.inkMid, fontSize: 12 },
  chip: { borderColor: color.border, borderWidth: border.hairline, paddingHorizontal: 6, paddingVertical: 2 },
  chipText: { color: color.ink, fontSize: 10, fontWeight: "700", lineHeight: 12 },
  properties: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 12 },
  property: { alignItems: "center", flexDirection: "row", gap: 8, maxWidth: "100%" },
  propertyLabel: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  fact: { color: color.ink, flexShrink: 1, fontSize: 14, lineHeight: 18 },
  assignee: { backgroundColor: color.page, borderColor: color.border, borderWidth: border.strong, paddingHorizontal: 8, paddingVertical: 4 },
  assigneeText: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16, maxWidth: 160 },
  notice: { color: color.red, fontSize: 12, lineHeight: 16, marginTop: 8 },
  modal: { flex: 1, justifyContent: "flex-end" },
  scrim: { backgroundColor: color.scrim, flex: 1 },
  sheet: { backgroundColor: color.page, borderColor: color.border, borderTopWidth: border.strong, maxHeight: "70%", paddingBottom: 24, paddingHorizontal: 16, paddingTop: 16 },
  sheetTitle: { color: color.ink, fontSize: 16, fontWeight: "700", lineHeight: 20 },
  search: { borderColor: color.border, borderWidth: border.strong, color: color.ink, fontSize: 16, lineHeight: 22, marginTop: 12, paddingHorizontal: 12, paddingVertical: 8 },
  sheetList: { marginTop: 8 },
  choice: { paddingVertical: 10 },
  choiceLabel: { color: color.ink, fontSize: 14, lineHeight: 20 },
  choiceOn: { fontWeight: "700" },
  italic: { color: color.ink, fontSize: 14, fontStyle: "italic", lineHeight: 20 },
});
