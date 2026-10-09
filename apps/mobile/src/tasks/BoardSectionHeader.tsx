import { Pressable, StyleSheet, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import type { AppMessageId } from "../i18n/catalog";
import { useT } from "../i18n/provider";
import { AppText } from "../ui/text";
import { useSkinStyles, type SkinRoles } from "../ui/skin";
import { border, color } from "../ui/tokens";
import { sectionHighlighted, type BoardSection } from "./board";

export const BOARD_SECTION_LABEL: Record<BoardSection, AppMessageId> = {
  needsMe: "mobile.board.section.needsMe",
  inProgress: "mobile.board.section.inProgress",
  doneToday: "mobile.board.section.doneToday",
  todo: "mobile.board.section.todo",
};

// Progress-board section header (task #2, step 4): title pill + task count.
// needsMe is highlighted (the yellow action convention) so the one section
// waiting on the viewer stands out from the observational ones. Only the todo
// section is collapsible — pass onPress to get the chevron toggle.
export function BoardSectionHeader({
  section,
  count,
  collapsed,
  onPress,
}: {
  section: BoardSection;
  count: number;
  collapsed?: boolean;
  onPress?: () => void;
}) {
  const t = useT();
  const skinStyle = useSkinStyles(sectionSkin);
  const highlighted = sectionHighlighted(section, count);
  const body = (
    <View style={styles.header}>
      <View style={[styles.pill, highlighted ? skinStyle.pillHot : styles.pillPlain]}>
        <AppText style={styles.pillText}>{t(BOARD_SECTION_LABEL[section])}</AppText>
      </View>
      <AppText style={styles.count}>{String(count)}</AppText>
      {onPress ? (
        <View style={collapsed ? styles.chevronClosed : undefined}>
          <ChevronDown color={color.ink} size={14} strokeWidth={2.5} />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: "center", flexDirection: "row", gap: 8, paddingVertical: 4 },
  pill: {
    alignItems: "center",
    borderWidth: border.hairline,
    flexDirection: "row",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pillPlain: { backgroundColor: color.page, borderColor: color.borderSoft },
  pillText: { color: color.ink, fontSize: 10, fontWeight: "700", lineHeight: 12, textTransform: "uppercase" },
  count: { color: color.mutedStrong, fontFamily: "mono", fontSize: 12, lineHeight: 16 },
  chevronClosed: { transform: [{ rotate: "-90deg" }] },
});

function sectionSkin(skin: SkinRoles) {
  return StyleSheet.create({
    pillHot: { backgroundColor: skin.signal, borderColor: color.border },
  });
}
