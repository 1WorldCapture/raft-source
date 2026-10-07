import { color, fontSize } from "./tokens";

/** Phase-1 screen aliases. New UI should import `tokens` directly. */
export const colors = {
  bg: color.page,
  card: color.page,
  ink: color.ink,
  muted: color.muted,
  line: color.border,
  accent: color.pink,
  accentSoft: color.yellow,
  danger: color.red,
  mine: color.pink,
  mineText: color.white,
  other: color.page,
};

export const space = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
};

export { fontSize };
