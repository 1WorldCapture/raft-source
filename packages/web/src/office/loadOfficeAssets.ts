import { buildDynamicCatalog } from "../officePixel/office/layout/furnitureCatalog.js";
import type { LoadedAssetData } from "../officePixel/office/layout/furnitureCatalog.js";
import { setFloorSprites } from "../officePixel/office/floorTiles.js";
import { setWallSprites } from "../officePixel/office/wallTiles.js";
import { setCharacterTemplates } from "../officePixel/office/sprites/spriteData.js";

const ASSET_BASE = "/office-assets/";
const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const CHAR_FRAMES_PER_ROW = 7;
const CHARACTER_DIRECTIONS = ["down", "up", "right"] as const;
const FLOOR_TILE_SIZE = 16;
const WALL_PIECE_WIDTH = 16;
const WALL_PIECE_HEIGHT = 32;
const WALL_GRID_COLS = 4;
const WALL_BITMASK_COUNT = 16;
const PNG_ALPHA_THRESHOLD = 2;

interface AssetIndex {
  floors: string[];
  walls: string[];
  characters: string[];
}

interface CatalogEntry {
  id: string;
  label: string;
  category: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  furniturePath: string;
  groupId?: string;
  orientation?: string;
  state?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  canPlaceOnWalls?: boolean;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < PNG_ALPHA_THRESHOLD) return "";
  const rgb = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
  if (a >= 255) return rgb;
  return `${rgb}${a.toString(16).padStart(2, "0").toUpperCase()}`;
}

function readSprite(png: DecodedPng, width: number, height: number, offsetX = 0, offsetY = 0): string[][] {
  const sprite: string[][] = [];
  for (let y = 0; y < height; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < width; x += 1) {
      const idx = ((offsetY + y) * png.width + (offsetX + x)) * 4;
      row.push(rgbaToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]));
    }
    sprite.push(row);
  }
  return sprite;
}

async function decodePng(url: string): Promise<DecodedPng> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`office asset ${url} (${res.status})`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("office asset canvas");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: image.data };
}

let assetsPromise: Promise<void> | null = null;

async function decodeOfficeAssets(): Promise<void> {
  const [index, catalog] = await Promise.all([
    fetch(`${ASSET_BASE}asset-index.json`).then((res) => res.json() as Promise<AssetIndex>),
    fetch(`${ASSET_BASE}furniture-catalog.json`).then((res) => res.json() as Promise<CatalogEntry[]>),
  ]);

  const characters = await Promise.all(index.characters.map(async (file) => {
    const png = await decodePng(`${ASSET_BASE}characters/${file}`);
    const byDir = { down: [] as string[][][], up: [] as string[][][], right: [] as string[][][] };
    for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx += 1) {
      const dir = CHARACTER_DIRECTIONS[dirIdx];
      const frames: string[][][] = [];
      for (let frame = 0; frame < CHAR_FRAMES_PER_ROW; frame += 1) {
        frames.push(readSprite(png, CHAR_FRAME_W, CHAR_FRAME_H, frame * CHAR_FRAME_W, dirIdx * CHAR_FRAME_H));
      }
      byDir[dir] = frames;
    }
    return byDir;
  }));

  const floors = await Promise.all(index.floors.map(async (file) => {
    const png = await decodePng(`${ASSET_BASE}floors/${file}`);
    return readSprite(png, FLOOR_TILE_SIZE, FLOOR_TILE_SIZE);
  }));

  const walls = await Promise.all(index.walls.map(async (file) => {
    const png = await decodePng(`${ASSET_BASE}walls/${file}`);
    const set: string[][][] = [];
    for (let mask = 0; mask < WALL_BITMASK_COUNT; mask += 1) {
      const ox = (mask % WALL_GRID_COLS) * WALL_PIECE_WIDTH;
      const oy = Math.floor(mask / WALL_GRID_COLS) * WALL_PIECE_HEIGHT;
      set.push(readSprite(png, WALL_PIECE_WIDTH, WALL_PIECE_HEIGHT, ox, oy));
    }
    return set;
  }));

  const sprites: Record<string, string[][]> = {};
  await Promise.all(catalog.map(async (entry) => {
    const png = await decodePng(`${ASSET_BASE}${entry.furniturePath}`);
    sprites[entry.id] = readSprite(png, entry.width, entry.height);
  }));

  setCharacterTemplates(characters);
  setFloorSprites(floors);
  setWallSprites(walls);
  const loaded: LoadedAssetData = { catalog, sprites };
  if (!buildDynamicCatalog(loaded)) throw new Error("office furniture catalog");
}

export function loadOfficeAssets(): Promise<void> {
  if (!assetsPromise) {
    assetsPromise = decodeOfficeAssets().catch((error: unknown) => {
      assetsPromise = null;
      throw error;
    });
  }
  return assetsPromise;
}
