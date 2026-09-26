import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { HardShadow } from "./shadow";
import { AppText } from "./text";
import { border, color, pressShift, shadowOffset } from "./tokens";

export function BrutalButton({
  label,
  onPress,
  disabled,
  tone = "pink",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "pink" | "yellow" | "plain";
}) {
  const [pressed, setPressed] = useState(false);
  const offset = pressed ? shadowOffset.pressed : shadowOffset.md;
  const background = tone === "yellow" ? color.yellow : tone === "plain" ? color.page : color.pink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={disabled ? styles.disabled : undefined}
    >
      <HardShadow offset={offset}>
        <View style={[styles.face, { backgroundColor: background, transform: [{ translateX: pressed ? pressShift : 0 }, { translateY: pressed ? pressShift : 0 }] }]}>
          <AppText style={styles.label}>{label}</AppText>
        </View>
      </HardShadow>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  face: {
    alignItems: "center",
    borderColor: color.border,
    borderWidth: border.strong,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  label: { color: color.ink, fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.5 },
});
