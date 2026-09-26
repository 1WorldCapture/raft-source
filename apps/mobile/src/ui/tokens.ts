/** Values from `packages/web/src/index.css` `@theme` (lines 123–185) and the phase-2 size notes. */

export const color = {
  yellow: "#FFD440",
  pink: "#FE7DA8",
  cyan: "#27CCF3",
  lavender: "#BBAFE6",
  ink: "#141111",
  page: "#FFFFFF",
  white: "#FFFFFF",
  border: "#000000",
  orange: "#F8A16F",
  lime: "#A9D877",
  red: "#F97264",
  stone: "#C0B9B1",
  codeSurface: "#07111f",
  codeForeground: "#f5f7ff",
  link: "#1447E6",
  muted: "rgba(0, 0, 0, 0.45)",
  mutedStrong: "rgba(0, 0, 0, 0.5)",
  pinkSoft: "rgba(254, 125, 168, 0.2)",
  pinkChip: "rgba(254, 125, 168, 0.3)",
  cyanSoft: "rgba(39, 204, 243, 0.3)",
  yellowSoft: "rgba(255, 212, 64, 0.4)",
  orangeSoft: "rgba(248, 161, 111, 0.15)",
  inlineCode: "rgba(0, 0, 0, 0.05)",
  quoteBorder: "rgba(0, 0, 0, 0.4)",
  previewSurface: "rgba(0, 0, 0, 0.03)",
  scrim: "rgba(0, 0, 0, 0.9)",
} as const;

export const fontSize = {
  bodySm: { fontSize: 12, lineHeight: 16 },
  bodyMd: { fontSize: 14, lineHeight: 20 },
  bodyLg: { fontSize: 16, lineHeight: 24 },
  /** Home and list labels. Web sidebar text is `text-sm` (14px); the measured mobile row reads closer to 16px with a ~55px row. */
  list: { fontSize: 16, lineHeight: 22 },
  sender: { fontSize: 14, lineHeight: 18 },
  time: { fontSize: 12, lineHeight: 16 },
  panelTitle: { fontSize: 16, lineHeight: 20 },
  group: { fontSize: 12, lineHeight: 16 },
  date: { fontSize: 10, lineHeight: 14 },
  input: { fontSize: 16, lineHeight: 22 },
  badge: { fontSize: 10, lineHeight: 12 },
} as const;

export type BodyFontSize = "sm" | "md" | "lg";

export function bodyFont(preferred: string | null | undefined): { fontSize: number; lineHeight: number } {
  if (preferred === "sm") return fontSize.bodySm;
  if (preferred === "lg") return fontSize.bodyLg;
  return fontSize.bodyMd;
}

export const radius = {
  none: 0,
  chip: 4,
  badge: 4,
  status: 999,
} as const;

export const border = {
  hairline: 1,
  strong: 2,
} as const;

export const shadowOffset = {
  sm: 2,
  md: 4,
  lg: 6,
  pressed: 1,
} as const;

export const size = {
  header: 62,
  headerCompact: 48,
  iconButton: 36,
  avatar: 36,
  mentionMark: 16,
} as const;

export const pressShift = 2;
