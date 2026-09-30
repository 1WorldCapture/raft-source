import type { AgentOverview, AgentOverviewAgent, OfficePresence } from "./agentOverview";
import { durationTier, presenceDurationMs } from "./durationTier";
import type { DurationTier } from "./durationTier";
import { TileType } from "../officePixel/office/types.js";
import type { OfficeLayout } from "../officePixel/office/types.js";

const INNER_W = 12;
const BASE_INNER_H = 14;
const ROOM_STRIDE = INNER_W + 1;
/** Three rooms across keeps six machines inside the canvas (cols stay under 64). */
const ROOMS_PER_ROW = 3;

const FLOOR_COLORS = [
  { h: 28, s: 35, b: 8, c: 0 },
  { h: 205, s: 30, b: 0, c: 0 },
];

const AREA_COLORS = ["#7fd4ff", "#ffe7a3", "#d7e4ff", "#ffb3c7"];

export interface OfficeBoss {
  id: string;
  name: string;
}

export interface OfficePlacement {
  agentId: string;
  name: string;
  presence: OfficePresence | "boss";
  tier: DurationTier;
  activity: string;
  roomMinCol: number;
  roomMaxCol: number;
  seatId: string | null;
  anchorCol: number;
  anchorRow: number;
  spawnCol: number;
  spawnRow: number;
  /** Door columns. Wander targets skip these so people don't rest in the doorway. */
  avoidCols?: number[];
  highlighted?: boolean;
}

export interface OfficeScene {
  layout: OfficeLayout;
  placements: OfficePlacement[];
  /** Changes when rooms or who is seated must be rebuilt. */
  structureKey: string;
}

interface RoomInput {
  label: string;
  agents: AgentOverviewAgent[];
}

function uniqueLabel(name: string, used: Set<string>): string {
  const base = name.trim() || "room";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base} ${n}`)) n += 1;
  const label = `${base} ${n}`;
  used.add(label);
  return label;
}

const DESKS_PER_ROW = 2;
const DESK_ROW_STRIDE = 5;

const SOFAS_PER_ROW = 3;

/** Desks fill the room; offline agents also need a sofa row under the desks. */
function innerHeight(agents: AgentOverviewAgent[]): number {
  if (agents.length === 0) return BASE_INNER_H;
  const deskRows = Math.ceil(agents.length / DESKS_PER_ROW);
  const offline = agents.filter((agent) => agent.presence === "offline").length;
  const sofaRows = offline === 0 ? 0 : Math.ceil(offline / SOFAS_PER_ROW);
  return Math.max(BASE_INNER_H, deskRows * DESK_ROW_STRIDE + sofaRows * 2 + 2);
}

export function buildOfficeScene(
  overview: AgentOverview,
  nowMs: number,
  bosses: OfficeBoss[] = [],
  highlightQuery = "",
): OfficeScene {
  const used = new Set<string>();
  const rooms: RoomInput[] = overview.machines.map((machine) => ({
    label: uniqueLabel(machine.name, used),
    agents: machine.agents,
  }));
  if (rooms.length === 0) {
    return {
      layout: {
        version: 1,
        cols: 8,
        rows: 6,
        tiles: Array.from({ length: 48 }, () => TileType.WALL),
        furniture: [],
      },
      placements: [],
      structureKey: "empty",
    };
  }

  const innerH = Math.max(...rooms.map((room) => innerHeight(room.agents)));
  const gridCols = Math.min(ROOMS_PER_ROW, rooms.length);
  const gridRows = Math.ceil(rooms.length / ROOMS_PER_ROW);
  const cols = 1 + gridCols * ROOM_STRIDE;
  const rows = 1 + gridRows * (innerH + 1);
  const tiles: TileType[] = Array.from({ length: cols * rows }, () => TileType.WALL);
  const tileColors: OfficeLayout["tileColors"] = Array.from({ length: cols * rows }, () => null);
  const areaTiles: Array<string | null> = Array.from({ length: cols * rows }, () => null);
  const furniture: OfficeLayout["furniture"] = [];
  const placements: OfficePlacement[] = [];
  const doorCols: number[] = [];

  rooms.forEach((room, index) => {
    const gridCol = index % ROOMS_PER_ROW;
    const gridRow = Math.floor(index / ROOMS_PER_ROW);
    const roomMinCol = 1 + gridCol * ROOM_STRIDE;
    const roomMaxCol = roomMinCol + INNER_W - 1;
    const roomFloorRow = 1 + gridRow * (innerH + 1);
    const floor = index % 2 === 0 ? TileType.FLOOR_1 : TileType.FLOOR_2;
    const color = FLOOR_COLORS[index % FLOOR_COLORS.length];
    for (let row = roomFloorRow; row < roomFloorRow + innerH; row += 1) {
      for (let col = roomMinCol; col <= roomMaxCol; col += 1) {
        const at = row * cols + col;
        tiles[at] = floor;
        tileColors[at] = color;
        areaTiles[at] = room.label;
      }
    }
    const hasRightNeighbor = gridCol < gridCols - 1 && index + 1 < rooms.length && Math.floor((index + 1) / ROOMS_PER_ROW) === gridRow;
    if (hasRightNeighbor) {
      const doorCol = roomMaxCol + 1;
      doorCols.push(doorCol);
      for (const doorRow of [roomFloorRow + 5, roomFloorRow + 6]) {
        if (doorRow >= roomFloorRow + innerH) continue;
        const at = doorRow * cols + doorCol;
        tiles[at] = floor;
        tileColors[at] = color;
        areaTiles[at] = room.label;
      }
    }
    const below = index + ROOMS_PER_ROW;
    if (below < rooms.length) {
      const wallRow = roomFloorRow + innerH;
      for (const doorCol of [roomMinCol + 5, roomMinCol + 6]) {
        const at = wallRow * cols + doorCol;
        tiles[at] = floor;
        tileColors[at] = color;
        areaTiles[at] = room.label;
      }
    }
    placeAgents(room.agents, roomMinCol, roomMaxCol, roomFloorRow, nowMs, furniture, placements);
  });

  for (const placement of placements) placement.avoidCols = doorCols;

  if (rooms.length > 0) {
    const query = highlightQuery.trim().toLowerCase();
    bosses.forEach((boss, index) => {
      const roomIndex = index % rooms.length;
      const gridCol = roomIndex % ROOMS_PER_ROW;
      const gridRow = Math.floor(roomIndex / ROOMS_PER_ROW);
      const roomMinCol = 1 + gridCol * ROOM_STRIDE;
      const roomFloorRow = 1 + gridRow * (innerH + 1);
      const col = roomMinCol + 4;
      const row = roomFloorRow + 3 + (Math.floor(index / rooms.length) % 3);
      placements.push({
        agentId: boss.id,
        name: boss.name,
        presence: "boss",
        tier: 0,
        activity: "",
        roomMinCol: 1,
        roomMaxCol: cols - 2,
        seatId: null,
        anchorCol: col,
        anchorRow: row,
        spawnCol: col,
        spawnRow: row,
        avoidCols: doorCols,
        highlighted: query.length > 0 && boss.name.toLowerCase().includes(query),
      });
    });
  }

  const needle = highlightQuery.trim().toLowerCase();
  if (needle) {
    for (const placement of placements) {
      placement.highlighted = placement.name.toLowerCase().includes(needle);
    }
  }

  const structureKey = `${rooms
    .map((room) => `${room.label}:${room.agents.map((agent) => `${agent.id}:${agent.presence}`).join(",")}`)
    .join("|")}|boss:${bosses.map((boss) => boss.id).join(",")}`;

  return {
    layout: {
      version: 1,
      cols,
      rows,
      tiles,
      tileColors,
      furniture,
      areas: rooms.map((room, index) => ({
        label: room.label,
        color: AREA_COLORS[index % AREA_COLORS.length],
      })),
      areaTiles,
    },
    placements,
    structureKey,
  };
}

function placeAgents(
  agents: AgentOverviewAgent[],
  roomMinCol: number,
  roomMaxCol: number,
  roomFloorRow: number,
  nowMs: number,
  furniture: OfficeLayout["furniture"],
  placements: OfficePlacement[],
): void {
  const deskRows = Math.ceil(agents.length / DESKS_PER_ROW);
  const sofaRow = roomFloorRow + deskRows * DESK_ROW_STRIDE + 1;
  let offlineSlot = 0;
  agents.forEach((agent, index) => {
    const tier = durationTier(agent.presence, presenceDurationMs(agent.presenceSince, nowMs));
    const activity = agent.activityDetail?.trim() || agent.activity;
    const col = roomMinCol + 2 + (index % DESKS_PER_ROW) * 5;
    const row = roomFloorRow + Math.floor(index / DESKS_PER_ROW) * DESK_ROW_STRIDE;
    const chairId = `chair-${agent.id}`;
    furniture.push(
      { uid: chairId, type: "WOODEN_CHAIR_FRONT", col, row },
      { uid: `desk-${agent.id}`, type: "DESK_FRONT", col: col - 1, row: row + 2 },
    );
    if (agent.presence === "offline") {
      const sofaCol = roomMinCol + 1 + (offlineSlot % SOFAS_PER_ROW) * 4;
      const sofaAt = sofaRow + Math.floor(offlineSlot / SOFAS_PER_ROW) * 2;
      const sofaId = `sofa-${agent.id}`;
      furniture.push({ uid: sofaId, type: "SOFA_FRONT", col: sofaCol, row: sofaAt });
      offlineSlot += 1;
      placements.push({
        agentId: agent.id,
        name: agent.name,
        presence: agent.presence,
        tier,
        activity,
        roomMinCol,
        roomMaxCol,
        seatId: sofaId,
        anchorCol: sofaCol,
        anchorRow: sofaAt,
        spawnCol: sofaCol,
        spawnRow: sofaAt,
      });
      return;
    }
    placements.push({
      agentId: agent.id,
      name: agent.name,
      presence: agent.presence,
      tier,
      activity,
      roomMinCol,
      roomMaxCol,
      seatId: agent.presence === "working" ? chairId : null,
      anchorCol: col,
      anchorRow: row + 1,
      spawnCol: col,
      spawnRow: row + 1,
    });
  });
}
