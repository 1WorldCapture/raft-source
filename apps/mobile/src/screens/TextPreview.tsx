import { useMemo } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { chunkTextLines } from "../attachments/textChunks";
import { useT } from "../i18n/provider";
import { AppText } from "../ui/text";
import { HardShadow } from "../ui/shadow";
import { border, color, shadowOffset } from "../ui/tokens";

export function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  const t = useT();
  const chunks = useMemo(() => chunkTextLines(text), [text]);
  return (
    <View style={styles.canvas}>
      {truncated ? <AppText style={styles.banner}>{t("mobile.preview.truncated")}</AppText> : null}
      <HardShadow offset={shadowOffset.sm} style={styles.shadow}>
        <FlatList
          data={chunks}
          keyExtractor={(_item, index) => String(index)}
          renderItem={({ item }) => (
            <AppText selectable style={styles.line}>{item.length > 0 ? item : "\u00a0"}</AppText>
          )}
          style={styles.sheet}
          contentContainerStyle={styles.sheetContent}
        />
      </HardShadow>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { backgroundColor: color.previewCream, flex: 1, padding: 16 },
  banner: {
    backgroundColor: color.white,
    borderColor: color.border,
    borderWidth: border.strong,
    color: color.ink,
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  shadow: { flex: 1 },
  sheet: {
    backgroundColor: color.white,
    borderColor: color.border,
    borderWidth: border.strong,
    flex: 1,
  },
  sheetContent: { padding: 16 },
  line: { color: color.ink, fontFamily: "mono", fontSize: 12, lineHeight: 20 },
});
