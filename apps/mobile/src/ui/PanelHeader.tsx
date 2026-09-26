import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { HardShadow } from "./shadow";
import { AppText } from "./text";
import { border, color, pressShift, shadowOffset, size } from "./tokens";

/** Mirrors web `PanelHeader`: white bar with a 2px bottom rule; tab roots use the yellow chrome. */
export function PanelHeader({
  title,
  subtitle,
  onBack,
  onTitlePress,
  actions,
  icon,
  tone = "white",
  safeArea = true,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  onTitlePress?: () => void;
  actions?: ReactNode;
  /** 36px icon slot drawn before the title, e.g. `<HeaderIconSlot>`. */
  icon?: ReactNode;
  tone?: "white" | "yellow";
  /** Pages without a stack header draw under the status bar unless this is set. */
  safeArea?: boolean;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const top = safeArea ? insets.top : 0;
  const bar = height <= 600 ? size.headerCompact : size.header;
  return (
    <View style={[styles.bar, { backgroundColor: tone === "yellow" ? color.yellow : color.page, height: bar + top, paddingTop: top }]}>
      {onBack ? (
        <HeaderIconButton accessibilityLabel="Back" onPress={onBack}>
          <ArrowLeft color={color.ink} size={16} strokeWidth={2.5} />
        </HeaderIconButton>
      ) : null}
      {icon}
      <Pressable disabled={!onTitlePress} onPress={onTitlePress} style={styles.titles}>
        <AppText numberOfLines={1} style={styles.title}>{title}</AppText>
        {subtitle ? <AppText numberOfLines={1} style={styles.subtitle}>{subtitle}</AppText> : null}
      </Pressable>
      <View style={styles.actions}>{actions}</View>
    </View>
  );
}

/** Web `size-icon-header` slot: 36px square, 2px black border, yellow fill by default. */
export function HeaderIconSlot({ children, fill = color.yellow }: { children: ReactNode; fill?: string }) {
  return <View style={[styles.slot, { backgroundColor: fill }]}>{children}</View>;
}

/** Bordered 36px header button with the 2px hard shadow and press shift used on web. */
export function HeaderIconButton({
  children,
  onPress,
  accessibilityLabel,
  wide,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel?: string;
  wide?: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
    >
      <HardShadow offset={pressed ? shadowOffset.pressed : shadowOffset.sm}>
        <View style={[styles.button, wide ? styles.buttonWide : null, pressed ? styles.buttonPressed : null]}>{children}</View>
      </HardShadow>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    borderBottomColor: color.border,
    borderBottomWidth: border.strong,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 12,
  },
  slot: {
    alignItems: "center",
    borderColor: color.border,
    borderWidth: border.strong,
    height: size.iconButton,
    justifyContent: "center",
    width: size.iconButton,
  },
  button: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    flexDirection: "row",
    gap: 4,
    height: size.iconButton - shadowOffset.sm,
    justifyContent: "center",
    minWidth: size.iconButton - shadowOffset.sm,
  },
  buttonWide: { paddingHorizontal: 8 },
  buttonPressed: { transform: [{ translateX: pressShift / 2 }, { translateY: pressShift / 2 }] },
  titles: { flex: 1 },
  title: { color: color.ink, fontSize: 16, fontWeight: "700", lineHeight: 20 },
  subtitle: { color: color.mutedStrong, fontFamily: "mono", fontSize: 12 },
  actions: { alignItems: "center", flexDirection: "row", gap: 6 },
});
