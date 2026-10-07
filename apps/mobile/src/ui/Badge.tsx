import { StyleSheet, View } from "react-native";
import { AppText } from "./text";
import { border, color, fontSize, radius, size } from "./tokens";

export function Badge({ count, quiet }: { count: number; quiet?: boolean }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  if (quiet) return <AppText style={styles.quiet}>{label}</AppText>;
  return (
    <View style={styles.badge}>
      <AppText style={styles.label}>{label}</AppText>
    </View>
  );
}

export function MentionMark() {
  return (
    <View style={styles.mark}>
      <AppText style={styles.markLabel}>@</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: color.pink,
    borderColor: color.border,
    borderRadius: radius.badge,
    borderWidth: border.hairline,
    minWidth: 18,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  label: { color: color.white, fontSize: fontSize.badge.fontSize, fontWeight: "700", textAlign: "center" },
  quiet: { color: color.muted, fontFamily: "mono", fontSize: fontSize.badge.fontSize, fontWeight: "700" },
  mark: {
    alignItems: "center",
    backgroundColor: color.yellow,
    borderRadius: radius.badge,
    height: size.mentionMark,
    justifyContent: "center",
    width: size.mentionMark,
  },
  markLabel: { color: color.ink, fontSize: 11, fontWeight: "700" },
});
