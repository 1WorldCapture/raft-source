import { useEffect, useRef } from "react";
import { Animated, Image, StyleSheet, View } from "react-native";
import { User } from "lucide-react-native";
import { pixelColor, resolvePixel } from "./pixelAvatar";
import { AppText } from "./text";
import { border, color, radius } from "./tokens";

export function Avatar({
  name,
  kind = "human",
  avatarUrl,
  size = 36,
  status,
}: {
  name: string;
  kind?: "human" | "agent" | "server";
  avatarUrl?: string | null;
  size?: number;
  status?: "online" | "busy" | "error" | "offline";
}) {
  const pixel = kind === "agent" ? resolvePixel(avatarUrl) : null;
  const stroke = size >= 36 ? border.strong : border.hairline;
  const fill = kind === "agent" ? color.cyan : kind === "server" ? color.ink : color.lavender;
  const letter = (name.trim()[0] || "?").toUpperCase();
  const photo = !pixel && avatarUrl && /^https?:\/\//.test(avatarUrl) ? avatarUrl : null;
  return (
    <View style={{ width: size, height: size }}>
      <View style={[styles.box, { width: size, height: size, borderWidth: stroke, backgroundColor: pixel ? pixel.bg : fill }]}>
        {pixel ? (
          pixel.grid.map((row, y) => (
            <View key={y} style={{ flexDirection: "row", height: size / 8 }}>
              {row.map((cell, x) => (
                <View key={x} style={{ width: size / 8, height: size / 8, backgroundColor: pixelColor(cell) }} />
              ))}
            </View>
          ))
        ) : photo ? (
          <Image source={{ uri: photo }} style={{ width: size - stroke * 2, height: size - stroke * 2 }} />
        ) : kind === "human" ? (
          <User color={color.ink} size={Math.round(size * 0.5)} strokeWidth={2.25} />
        ) : (
          <AppText style={[styles.letter, { color: kind === "server" ? color.yellow : color.ink, fontSize: size * 0.42 }]}>{letter}</AppText>
        )}
      </View>
      {status ? <StatusDot status={status} /> : null}
    </View>
  );
}

function StatusDot({ status }: { status: "online" | "busy" | "error" | "offline" }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (status !== "busy") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 450, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, status]);
  return <Animated.View style={[styles.status, { backgroundColor: statusColor(status), opacity: status === "busy" ? opacity : 1 }]} />;
}

function statusColor(status: "online" | "busy" | "error" | "offline"): string {
  if (status === "online") return color.lime;
  if (status === "busy") return color.yellow;
  if (status === "error") return color.orange;
  return color.stone;
}

const styles = StyleSheet.create({
  box: { borderColor: color.border, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  letter: { fontWeight: "700" },
  status: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 10,
    height: 10,
    borderRadius: radius.status,
    borderWidth: border.hairline,
    borderColor: color.border,
  },
});
