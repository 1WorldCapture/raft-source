import { ActivityIndicator, Pressable, StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import { useT } from "../i18n/provider";
import { BrutalButton } from "./BrutalButton";
import { AppText } from "./text";
import { colors, space } from "./theme";
import { border, color, fontSize } from "./tokens";

export function ScreenMessage({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.center}>
      <AppText style={styles.title}>{title}</AppText>
      {body ? <AppText style={styles.body}>{body}</AppText> : null}
    </View>
  );
}

export function LoadingScreen() {
  const t = useT();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
      <AppText style={styles.body}>{t("common.loading")}</AppText>
    </View>
  );
}

export function Field(props: TextInputProps) {
  return <TextInput placeholderTextColor={colors.muted} style={styles.input} {...props} />;
}

export function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <BrutalButton disabled={disabled} label={label} onPress={onPress} />;
}

export function ErrorText({ children }: { children: string }) {
  return <AppText style={styles.error}>{children}</AppText>;
}

export function QuietPress({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      <AppText style={styles.link}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.lg,
    backgroundColor: colors.bg,
    gap: space.sm,
  },
  title: { fontSize: 18, fontWeight: "700", color: colors.ink, textAlign: "center" },
  body: { fontSize: 15, color: colors.muted, textAlign: "center" },
  input: {
    backgroundColor: colors.card,
    borderColor: color.border,
    borderWidth: border.strong,
    borderRadius: 0,
    color: colors.ink,
    fontSize: fontSize.input.fontSize,
    fontFamily: "SpaceGrotesk-400",
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  error: { color: colors.danger, fontSize: 14 },
  link: { color: colors.accent, fontWeight: "700" },
});
