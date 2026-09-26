import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { colors, space } from "./theme";

export function ScreenMessage({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
    </View>
  );
}

export function LoadingScreen() {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.body}>正在打开</Text>
    </View>
  );
}

export function Field(props: TextInputProps) {
  return <TextInput placeholderTextColor={colors.muted} style={styles.input} {...props} />;
}

export function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.buttonDisabled]}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

export function ErrorText({ children }: { children: string }) {
  return <Text style={styles.error}>{children}</Text>;
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
  title: { fontSize: 18, fontWeight: "600", color: colors.ink, textAlign: "center" },
  body: { fontSize: 15, color: colors.muted, textAlign: "center" },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.ink,
    fontSize: 16,
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { color: "#fff", fontSize: 16, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 14 },
});
