import { StyleSheet, View } from "react-native";
import { AppText } from "./text";
import { border, color, radius } from "./tokens";

export function Chip({ label, kind }: { label: string; kind: "mention" | "channel" | "thread" }) {
  const background = kind === "mention" ? color.yellow : kind === "channel" ? color.pink : color.cyan;
  return (
    <View style={[styles.chip, { backgroundColor: background }]}>
      <AppText style={styles.label}>{label}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    borderColor: color.border,
    borderRadius: radius.chip,
    borderWidth: border.hairline,
    paddingHorizontal: 4,
  },
  label: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16 },
});
