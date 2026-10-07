import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { color } from "./tokens";

export function HardShadow({
  children,
  offset,
  style,
}: {
  children: ReactNode;
  offset: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ paddingRight: offset, paddingBottom: offset }, style]}>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: offset,
          left: offset,
          right: 0,
          bottom: 0,
          backgroundColor: color.ink,
        }}
      />
      {children}
    </View>
  );
}
