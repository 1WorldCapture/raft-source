import pixelAvatars from "../../../../packages/web/assets/avatars/pixelAvatars.json";

type PaletteKey = keyof typeof pixelAvatars.palette;
type Grid = { grid: string[][]; bg: string };

const palette = pixelAvatars.palette;
const reserved = new Set(pixelAvatars.reservedKeys);

const avatars: Record<string, Grid> = Object.fromEntries(
  Object.entries(pixelAvatars.avatars).map(([key, avatar]) => [
    key,
    {
      bg: avatar.bg.startsWith("#") ? avatar.bg : palette[avatar.bg as PaletteKey],
      grid: avatar.grid.map((row) => row.split("")),
    },
  ]),
);

const schemes: Array<[string, PaletteKey]> = [
  [palette.C, "K"],
  [palette.Y, "K"],
  [palette.L, "K"],
  [palette.P, "W"],
  [palette.V, "K"],
  ["#1E1E1C", "C"],
  ["#1E1E1C", "G"],
  ["#1E1E1C", "P"],
  ["#1E1E1C", "Y"],
  ["#1E1E1C", "V"],
  [palette.O, "K"],
  [palette.C, "W"],
];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return hash;
}

function generate(seed: string): Grid {
  const rng = mulberry32(hashString(seed));
  const scheme = schemes[Math.floor(rng() * schemes.length)] ?? schemes[0];
  const grid: string[][] = [];
  for (let y = 0; y < 8; y += 1) {
    const left: string[] = [];
    for (let x = 0; x < 4; x += 1) left.push(rng() < 0.45 ? scheme[1] : "_");
    grid.push([left[0], left[1], left[2], left[3], left[3], left[2], left[1], left[0]]);
  }
  return { grid, bg: scheme[0] };
}

export function resolvePixel(avatarUrl: string | null | undefined): Grid | null {
  if (!avatarUrl?.startsWith("pixel:")) return null;
  const key = avatarUrl.slice("pixel:".length);
  if (key.startsWith("random:")) return generate(key.slice("random:".length));
  return avatars[key] ?? avatars[pixelAvatars.defaultKey] ?? null;
}

export function pixelColor(letter: string): string {
  const value = palette[letter as PaletteKey];
  return value && value !== "transparent" ? value : "transparent";
}

export function isReservedPixel(key: string): boolean {
  return reserved.has(key);
}
