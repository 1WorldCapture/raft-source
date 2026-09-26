import { Platform } from "react-native";

export const fontAssets = {
  "SpaceGrotesk-400": require("../../../../packages/web/src/assets/fonts/space-grotesk-0.ttf"),
  "SpaceGrotesk-500": require("../../../../packages/web/src/assets/fonts/space-grotesk-1.ttf"),
  "SpaceGrotesk-600": require("../../../../packages/web/src/assets/fonts/space-grotesk-2.ttf"),
  "SpaceGrotesk-700": require("../../../../packages/web/src/assets/fonts/space-grotesk-3.ttf"),
  "SpaceMono-400": require("../../../../packages/web/src/assets/fonts/space-mono-4.ttf"),
  "SpaceMono-700": require("../../../../packages/web/src/assets/fonts/space-mono-5.ttf"),
} as const;

/** CJK is not in Space Grotesk. iOS uses PingFang; Android uses the system sans, which is Noto Sans CJK on our devices. */
export const cjkFamily = Platform.OS === "ios" ? "PingFang SC" : "sans-serif";

export function latinFamily(weight?: string, mono = false): string {
  if (mono) return weight === "700" || weight === "bold" ? "SpaceMono-700" : "SpaceMono-400";
  if (weight === "700" || weight === "bold") return "SpaceGrotesk-700";
  if (weight === "600") return "SpaceGrotesk-600";
  if (weight === "500") return "SpaceGrotesk-500";
  return "SpaceGrotesk-400";
}
