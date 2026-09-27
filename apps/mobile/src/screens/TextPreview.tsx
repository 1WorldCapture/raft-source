import { useMemo } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { chunkTextLines } from "../attachments/textChunks";
import { AppText } from "../ui/text";
import { HardShadow } from "../ui/shadow";
import { border, color, shadowOffset } from "../ui/tokens";
import { TruncationBanner } from "./TruncationBanner";

export function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  const chunks = useMemo(() => chunkTextLines(text), [text]);
  return (
    <View style={styles.canvas}>
      {truncated ? <TruncationBanner /> : null}
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
