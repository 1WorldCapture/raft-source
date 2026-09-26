import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Ban, Check, CheckCircle, ChevronDown, Circle, Eye, Hash, Pencil, Play, User, UserCircle2 } from "lucide-react-native";
import type { AppMessageId } from "../i18n/catalog";
import { useT } from "../i18n/provider";
import { HardShadow } from "../ui/shadow";
import { AppText } from "../ui/text";
import { border, color, shadowOffset } from "../ui/tokens";
import {
  matchingChoices,
  taskStatusFill,
  channelLabel,
  plainDescription,
  type FilterChoice,
} from "./list";
import { taskStatusOptions, type RaftTask, type TaskStatus, type TaskStatusOption } from "./model";

const STATUS_LABEL: Record<TaskStatus, AppMessageId> = {
  todo: "task.status.todo",
  in_progress: "task.status.inProgress",
  in_review: "task.status.inReview",
  done: "task.status.done",
  closed: "task.status.closed",
};

export function TaskFilterChip({
  label,
  icon,
  count,
  onPress,
}: {
  label: string;
  icon: "channel" | "creator" | "assignee";
  count: number;
  onPress: () => void;
}) {
  const selected = count > 0;
  const face = (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.chip, selected ? styles.chipOn : styles.chipOff]}>
      {icon === "channel" ? <Hash color={selected ? color.ink : color.inkLabel} size={14} strokeWidth={2.5} /> : null}
      {icon === "creator" ? <UserCircle2 color={selected ? color.ink : color.inkLabel} size={14} strokeWidth={2.5} /> : null}
      {icon === "assignee" ? <User color={selected ? color.ink : color.inkLabel} size={14} strokeWidth={2.5} /> : null}
      <AppText style={[styles.chipText, selected ? null : styles.chipTextOff]}>{label}</AppText>
      {selected ? <AppText style={styles.count}>{String(count)}</AppText> : null}
      <ChevronDown color={selected ? color.ink : color.inkLabel} size={12} strokeWidth={2.5} />
    </Pressable>
  );
  if (!selected) return face;
  return <HardShadow offset={shadowOffset.sm}>{face}</HardShadow>;
}

export function TaskGroupHeader({
  status,
  count,
  collapsed,
  onPress,
}: {
  status: TaskStatus;
  count: number;
  collapsed: boolean;
  onPress: () => void;
}) {
  const t = useT();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.groupHeader}>
      <View style={[styles.statusPill, { backgroundColor: taskStatusFill(status) }]}>
        <StatusIcon status={status} size={10} />
        <AppText style={styles.statusPillText}>{t(STATUS_LABEL[status])}</AppText>
      </View>
      <AppText style={styles.groupCount}>{String(count)}</AppText>
      <View style={collapsed ? styles.chevronClosed : undefined}>
        <ChevronDown color={color.ink} size={14} strokeWidth={2.5} />
      </View>
    </Pressable>
  );
}

export function TaskEmptyGroup({ status }: { status: TaskStatus }) {
  const t = useT();
  return (
    <View style={styles.emptyGroup}>
      <AppText style={styles.emptyGroupText}>{t("task.status.emptyGroup", { status: t(STATUS_LABEL[status]) })}</AppText>
    </View>
  );
}

export function TaskCardView({
  task,
  role,
  onStatus,
}: {
  task: RaftTask;
  role: string | null;
  onStatus: (status: TaskStatus) => void;
}) {
  const t = useT();
  const [pressed, setPressed] = useState(false);
  const [menu, setMenu] = useState(false);
  const description = plainDescription(task.description);
  const options = taskStatusOptions(task.status, role);
  const readOnly = options.length === 0;
  return (
    <HardShadow offset={pressed ? 1 : shadowOffset.sm}>
      <View style={[styles.card, pressed ? styles.cardPressed : null]}>
        <View style={styles.metaRow}>
          <AppText numberOfLines={1} style={styles.channel}>{channelLabel(task.channelName)}</AppText>
          <AppText style={styles.number}>{`#${task.taskNumber}`}</AppText>
        </View>
        <AppText numberOfLines={3} style={styles.title}>{task.title}</AppText>
        {description ? <AppText numberOfLines={2} style={styles.description}>{description}</AppText> : null}
        <View style={styles.statusSlot}>
          {readOnly ? (
            <View style={[styles.statusButton, { backgroundColor: taskStatusFill(task.status) }]}>
              <StatusIcon status={task.status} size={10} />
              <AppText style={styles.statusButtonText}>{t(STATUS_LABEL[task.status])}</AppText>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setMenu(true)}
              onPressIn={() => setPressed(true)}
              onPressOut={() => setPressed(false)}
            >
              <View style={[styles.statusButton, { backgroundColor: taskStatusFill(task.status) }]}>
                <Pencil color={color.ink} size={10} strokeWidth={2.5} />
                <AppText style={styles.statusButtonText}>{t(STATUS_LABEL[task.status])}</AppText>
              </View>
            </Pressable>
          )}
        </View>
        {menu ? (
          <StatusMenu
            current={task.status}
            onClose={() => setMenu(false)}
            onSelect={(status) => {
              setMenu(false);
              onStatus(status);
            }}
            options={options}
          />
        ) : null}
      </View>
    </HardShadow>
  );
}

export function TaskSkeleton() {
  return (
    <View style={styles.skeleton}>
      <View style={[styles.bone, styles.boneShort]} />
      <View style={[styles.bone, styles.boneLong]} />
    </View>
  );
}

export function FilterSheet({
  title,
  choices,
  pinned,
  selected,
  onClose,
  onToggle,
}: {
  title: string;
  choices: readonly FilterChoice[];
  pinned: readonly FilterChoice[];
  selected: readonly string[];
  onClose: () => void;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const pinnedShown = matchingChoices(pinned, query);
  const shown = matchingChoices(choices, query);
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <View style={styles.modal}>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.scrim} />
      <View style={styles.sheet}>
        <AppText style={styles.sheetTitle}>{title}</AppText>
        <TextInput
          onChangeText={setQuery}
          placeholder={title}
          placeholderTextColor={color.muted}
          style={styles.search}
          value={query}
        />
        <ScrollView keyboardShouldPersistTaps="handled" style={styles.sheetList}>
          {pinnedShown.map((choice) => (
            <ChoiceRow choice={choice} key={choice.id} onPress={() => onToggle(choice.id)} selected={selected.includes(choice.id)} />
          ))}
          {shown.map((choice) => (
            <ChoiceRow choice={choice} key={choice.id} onPress={() => onToggle(choice.id)} selected={selected.includes(choice.id)} />
          ))}
          {pinnedShown.length === 0 && shown.length === 0 ? <AppText style={styles.emptySearch}>{t("task.filter.noMatchHint")}</AppText> : null}
        </ScrollView>
      </View>
      </View>
    </Modal>
  );
}

function ChoiceRow({ choice, selected, onPress }: { choice: FilterChoice; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={styles.choice}>
      <View style={[styles.box, selected ? styles.boxOn : null]}>{selected ? <Check color={color.ink} size={12} strokeWidth={3} /> : null}</View>
      <AppText style={[styles.choiceLabel, choice.italic ? styles.italic : null]}>{choice.label}</AppText>
    </Pressable>
  );
}

function StatusMenu({
  current,
  options,
  onClose,
  onSelect,
}: {
  current: TaskStatus;
  options: readonly TaskStatusOption[];
  onClose: () => void;
  onSelect: (status: TaskStatus) => void;
}) {
  const t = useT();
  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible>
      <View style={styles.modal}>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.scrim} />
      <View style={styles.menu}>
        {options.map((option) => (
          <Pressable key={option.id} onPress={() => onSelect(option.id)} style={styles.menuRow}>
            <View style={[styles.menuSwatch, { backgroundColor: taskStatusFill(option.id) }]}>
              <StatusIcon status={option.id} size={12} />
            </View>
            <AppText style={styles.menuLabel}>{t(option.labelId)}</AppText>
            {option.id === current ? <Check color={color.ink} size={14} strokeWidth={3} /> : null}
          </Pressable>
        ))}
      </View>
      </View>
    </Modal>
  );
}

function StatusIcon({ status, size }: { status: TaskStatus; size: number }) {
  const props = { color: color.ink, size, strokeWidth: 2.5 };
  if (status === "in_progress") return <Play {...props} />;
  if (status === "in_review") return <Eye {...props} />;
  if (status === "done") return <CheckCircle {...props} />;
  if (status === "closed") return <Ban {...props} />;
  return <Circle {...props} />;
}

const styles = StyleSheet.create({
  modal: { flex: 1, justifyContent: "flex-end" },
  chip: {
    alignItems: "center",
    borderWidth: border.strong,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipOn: { backgroundColor: color.yellow, borderColor: color.border },
  chipOff: { backgroundColor: color.page, borderColor: color.borderSoft },
  chipText: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  chipTextOff: { color: color.inkLabel },
  count: {
    borderColor: color.border,
    borderWidth: border.hairline,
    color: color.ink,
    fontFamily: "mono",
    fontSize: 10,
    lineHeight: 12,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  groupHeader: { alignItems: "center", flexDirection: "row", gap: 8, paddingVertical: 4 },
  statusPill: {
    alignItems: "center",
    borderColor: color.border,
    borderWidth: border.hairline,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  statusPillText: { color: color.ink, fontSize: 10, fontWeight: "700", lineHeight: 12, textTransform: "uppercase" },
  groupCount: { color: color.mutedStrong, flex: 1, fontFamily: "mono", fontSize: 12, lineHeight: 16 },
  chevronClosed: { transform: [{ rotate: "-90deg" }] },
  emptyGroup: { borderColor: color.borderFaint, borderStyle: "dashed", borderWidth: border.strong, paddingHorizontal: 12, paddingVertical: 20 },
  emptyGroupText: { color: color.muted, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: color.page, borderColor: color.border, borderWidth: border.strong, paddingHorizontal: 12, paddingVertical: 10 },
  cardPressed: { transform: [{ translateX: 1 }, { translateY: 1 }] },
  metaRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  channel: { color: color.inkMid, flexShrink: 1, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  number: { color: color.inkFaint, fontFamily: "mono", fontSize: 11, lineHeight: 14 },
  title: { color: color.ink, fontSize: 14, fontWeight: "700", lineHeight: 20, marginTop: 4, paddingRight: 8 },
  description: { color: color.inkLabel, fontSize: 12, lineHeight: 16, marginTop: 2 },
  statusSlot: { alignItems: "flex-end", marginTop: 8 },
  statusButton: {
    alignItems: "center",
    borderColor: color.border,
    borderWidth: border.strong,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusButtonText: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  skeleton: { borderColor: color.border, borderWidth: border.strong, gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  bone: { backgroundColor: color.mutedFill, height: 12 },
  boneShort: { width: "28%" },
  boneLong: { height: 14, width: "72%" },
  scrim: { backgroundColor: color.scrim, flex: 1 },
  sheet: { backgroundColor: color.page, borderColor: color.border, borderTopWidth: border.strong, maxHeight: "70%", paddingBottom: 24, paddingHorizontal: 16, paddingTop: 16 },
  sheetTitle: { color: color.ink, fontSize: 16, fontWeight: "700", lineHeight: 20 },
  search: { borderColor: color.border, borderWidth: border.strong, color: color.ink, fontSize: 16, lineHeight: 22, marginTop: 12, paddingHorizontal: 12, paddingVertical: 8 },
  sheetList: { marginTop: 8 },
  emptySearch: { color: color.muted, fontSize: 14, lineHeight: 20, paddingVertical: 12 },
  choice: { alignItems: "center", flexDirection: "row", gap: 10, paddingVertical: 10 },
  box: { alignItems: "center", borderColor: color.border, borderWidth: border.strong, height: 20, justifyContent: "center", width: 20 },
  boxOn: { backgroundColor: color.yellow },
  choiceLabel: { color: color.ink, flex: 1, fontSize: 14, lineHeight: 20 },
  italic: { fontStyle: "italic" },
  menu: { backgroundColor: color.page, borderColor: color.border, borderTopWidth: border.strong, paddingBottom: 24, paddingHorizontal: 16, paddingTop: 8 },
  menuRow: { alignItems: "center", flexDirection: "row", gap: 10, paddingVertical: 10 },
  menuSwatch: { alignItems: "center", borderColor: color.border, borderWidth: border.hairline, height: 22, justifyContent: "center", width: 22 },
  menuLabel: { color: color.ink, flex: 1, fontSize: 14, fontWeight: "700", lineHeight: 20 },
});
