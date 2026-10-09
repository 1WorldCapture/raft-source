import { StyleSheet, View } from "react-native";
import { AppText } from "./text";
import { useSkin } from "./skin";
import { border, color, radius } from "./tokens";

export function Chip({ label, kind }: { label: string; kind: "mention" | "channel" | "thread" }) {
  const skin = useSkin();
  const background = kind === "mention" ? skin.signal : kind === "channel" ? color.pink : color.cyan;
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
