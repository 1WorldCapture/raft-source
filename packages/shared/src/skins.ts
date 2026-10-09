// Skin palette shared by the desktop app and the mobile app.
//
// A skin is one chrome color (top bar, rail, headers). The signal accent — the
// selected and busy color — is a deeper shade of that same chrome, so every skin
// stays in one family. Desktop writes the accent as the CSS relative color
// `oklch(from <chrome> <lightness> <chroma> h)`, which re-hues raft-ui's
// brutal-yellow scale and keeps each step's lightness and chroma. Mobile cannot
// paint that CSS function, so `signalStepHex` resolves the same color to sRGB.
//
// Portability: import this file by path. Do not re-export it from the shared
// barrel. Mobile uses `@botiverse/raft-shared/src/skins.ts`. The server uses
// `@botiverse/raft-shared/src/skins.js` so the barrel stays out of its bundle.
// This file has no imports and does not touch the DOM.

export interface Skin {
  id: string;
  name: string;
  /** Surface color, `#RRGGBB`. The signal accent is derived from it. */
  chrome: string;
}

// Ordered around the hue wheel (warm → cool) then neutrals. Every chrome is
// light enough that black text and a 2px black border stay legible.
export const SKINS = [
  { id: "signal", name: "Signal", chrome: "#FFD440" },
  { id: "amber", name: "Amber", chrome: "#FBE08C" },
  { id: "peach", name: "Peach", chrome: "#FBCB9C" },
  { id: "coral", name: "Coral", chrome: "#F9B4A0" },
  { id: "blush", name: "Blush", chrome: "#F7BBCB" },
  { id: "rose", name: "Rose", chrome: "#EFA9C6" },
  { id: "lilac", name: "Lilac", chrome: "#D6C4F0" },
  { id: "iris", name: "Iris", chrome: "#BFC4F0" },
  { id: "sky", name: "Sky", chrome: "#A9D6F2" },
  { id: "aqua", name: "Aqua", chrome: "#A6E0DA" },
  { id: "sage", name: "Sage", chrome: "#C2E0AC" },
  { id: "sand", name: "Sand", chrome: "#E9DDC4" },
  { id: "cloud", name: "Cloud", chrome: "#D9E0E8" },
] as const satisfies readonly Skin[];

export type SkinId = (typeof SKINS)[number]["id"];

export const DEFAULT_SKIN_ID: SkinId = "rose";

/** raft-ui `--color-brutal-yellow-*` lightness and chroma. Hue comes from chrome. */
export const SIGNAL_SCALE = [
  { step: 50, lightness: "98.4%", chroma: "0.017" },
  { step: 100, lightness: "97.5%", chroma: "0.027" },
  { step: 200, lightness: "94%", chroma: "0.066" },
  { step: 300, lightness: "91.3%", chroma: "0.103" },
  { step: 400, lightness: "88.3%", chroma: "0.162" },
  { step: 500, lightness: "75.9%", chroma: "0.155" },
  { step: 600, lightness: "63.7%", chroma: "0.13" },
  { step: 700, lightness: "50.8%", chroma: "0.104" },
  { step: 800, lightness: "38.8%", chroma: "0.08" },
  { step: 900, lightness: "26%", chroma: "0.053" },
  { step: 950, lightness: "19.9%", chroma: "0.041" },
] as const;

/** Canonical selected/busy fill. Desktop points `--color-brutal-yellow` at this step. */
export const SIGNAL_ACCENT_STEP = 400;

export function isSkinId(id: unknown): id is SkinId {
  return typeof id === "string" && SKINS.some((skin) => skin.id === id);
}

export function skinById(id: string): (typeof SKINS)[number] {
  for (const skin of SKINS) if (skin.id === id) return skin;
  for (const skin of SKINS) if (skin.id === DEFAULT_SKIN_ID) return skin;
  return SKINS[0];
}

export function chromeChannels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function signalStepCss(chrome: string, step: number): string {
  const row = scaleRow(step);
  return `oklch(from ${chrome} ${row.lightness} ${row.chroma} h)`;
}

export function signalCss(chrome: string): string {
  return signalStepCss(chrome, SIGNAL_ACCENT_STEP);
}

/** sRGB hex of one scale step. Matches the color Chromium paints for `signalStepCss`. */
export function signalStepHex(chrome: string, step: number): string {
  const [r, g, b] = signalStepChannels(chrome, step);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function signalHex(chrome: string): string {
  return signalStepHex(chrome, SIGNAL_ACCENT_STEP);
}

function scaleRow(step: number): (typeof SIGNAL_SCALE)[number] {
  const row = SIGNAL_SCALE.find((item) => item.step === step);
  if (!row) throw new Error(`Unknown signal step ${step}`);
  return row;
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(linear: number): number {
  if (linear <= 0) return 0;
  const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, encoded) * 255);
}

function chromeHue(hex: string): number {
  const [redByte, greenByte, blueByte] = chromeChannels(hex);
  const red = srgbChannelToLinear(redByte);
  const green = srgbChannelToLinear(greenByte);
  const blue = srgbChannelToLinear(blueByte);
  const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
  const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
  const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  const labA = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const labB = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;
  const hue = (Math.atan2(labB, labA) * 180) / Math.PI;
  return hue < 0 ? hue + 360 : hue;
}

function signalStepChannels(chrome: string, step: number): [number, number, number] {
  const row = scaleRow(step);
  const lightness = Number.parseFloat(row.lightness) / 100;
  const chroma = Number.parseFloat(row.chroma);
  const radians = (chromeHue(chrome) * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;
  return [
    linearToSrgbByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
