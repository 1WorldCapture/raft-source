import { useEffect, useRef } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import type { ReactNode } from "react";
import { useSkinStyles, type SkinRoles } from "./skin";
import { AppText } from "./text";
import { color, size } from "./tokens";

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const skinStyle = useSkinStyles(sheetSkin);
  const translate = useRef(new Animated.Value(width)).current;
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => gesture.dx > 12,
    onPanResponderMove: (_event, gesture) => {
      if (gesture.dx > 0) translate.setValue(gesture.dx);
    },
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dx > width * 0.3) onClose();
      else Animated.timing(translate, { toValue: 0, duration: 160, useNativeDriver: true }).start();
    },
  })).current;

  useEffect(() => {
    Animated.timing(translate, { toValue: open ? 0 : width, duration: 180, useNativeDriver: true }).start();
  }, [open, translate, width]);

  if (!open) return null;
  return (
    <View style={styles.overlay}>
      <Pressable accessibilityRole="button" onPress={onClose} style={styles.backdrop} />
      <Animated.View style={[styles.panel, { width, transform: [{ translateX: translate }] }]} {...pan.panHandlers}>
        <View style={[styles.header, skinStyle.header]}>
          <AppText style={styles.title}>{title}</AppText>
        </View>
        <View style={styles.body}>{children}</View>
      </Animated.View>
    </View>
  );
}

const fill = { position: "absolute" as const, left: 0, right: 0, top: 0, bottom: 0 };

const styles = StyleSheet.create({
  overlay: { ...fill, zIndex: 20 },
  backdrop: { ...fill, backgroundColor: color.muted },
  panel: { position: "absolute", top: 0, bottom: 0, right: 0, backgroundColor: color.page },
  header: {
    borderBottomColor: color.border,
    borderBottomWidth: 2,
    height: size.header,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  title: { color: color.ink, fontSize: 16, fontWeight: "700" },
  body: { flex: 1, padding: 16 },
});

function sheetSkin(skin: SkinRoles) {
  return StyleSheet.create({
    header: { backgroundColor: skin.chrome },
  });
}
