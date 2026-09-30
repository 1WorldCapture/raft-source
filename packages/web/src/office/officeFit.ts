import { TILE_SIZE, ZOOM_MAX, ZOOM_MIN } from "../officePixel/constants.js";

/** Name baseline sits 60px above the body, and the glyph extends above that. */
const NAME_CLEARANCE_PX = 74;
/** First desk chair is on the first floor row, so its center is one and a half tiles down. */
const FIRST_SEAT_CENTER_Y = TILE_SIZE + TILE_SIZE / 2;
/** Wall sprites are two tiles tall and hang one tile above the map. */
const WALL_OVERHANG_PX = TILE_SIZE;
const EDGE_PX = 4;

/**
 * Largest zoom that keeps the top wall, the top row of names, and the bottom
 * edge inside the canvas. Integer when an integer still clears; otherwise a
 * fraction so a short viewport does not clip the top.
 */
export function fitOfficeZoom(
  canvasWidth: number,
  canvasHeight: number,
  cols: number,
  rows: number,
): number {
  if (canvasWidth < 32 || canvasHeight < 32 || cols < 1 || rows < 1) return ZOOM_MIN;
  const widthLimit = (canvasWidth - 24) / (cols * TILE_SIZE);
  const wallLimit = (canvasHeight - 2 * EDGE_PX) / (rows * TILE_SIZE + 2 * WALL_OVERHANG_PX);
  const nameDenom = rows * TILE_SIZE - 2 * FIRST_SEAT_CENTER_Y;
  const nameLimit = nameDenom > 0
    ? (canvasHeight - 2 * (NAME_CLEARANCE_PX + EDGE_PX)) / nameDenom
    : ZOOM_MAX;
  const limit = Math.min(ZOOM_MAX, widthLimit, wallLimit, nameLimit);
  if (!Number.isFinite(limit) || limit <= 0) return 0.25;
  const integer = Math.floor(limit);
  if (integer >= ZOOM_MIN) return integer;
  return Math.round(limit * 100) / 100;
}
