import type { AgentOverview, AgentOverviewAgent, OfficePresence } from "./agentOverview";
import { durationTier, presenceDurationMs } from "./durationTier";
import type { DurationTier } from "./durationTier";
import { TileType } from "../officePixel/office/types.js";
import type { OfficeLayout } from "../officePixel/office/types.js";

const INNER_W = 12;
const BASE_INNER_H = 14;
const ROOM_STRIDE = INNER_W + 1;

const FLOOR_COLORS = [
  { h: 28, s: 35, b: 8, c: 0 },
  { h: 205, s: 30, b: 0, c: 0 },
];

const AREA_COLORS = ["#7fd4ff", "#ffe7a3", "#d7e4ff", "#ffb3c7"];

export interface OfficePlacement {
  agentId: string;
  name: string;
  presence: OfficePresence;
  tier: DurationTier;
  activity: string;
  roomMinCol: number;
  roomMaxCol: number;
  seatId: string | null;
  anchorCol: number;
  anchorRow: number;
  spawnCol: number;
  spawnRow: number;
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

function innerHeight(agents: AgentOverviewAgent[]): number {
  const workers = agents.filter((agent) => agent.presence === "working").length;
  const workRows = Math.max(1, Math.ceil(workers / 2));
  return Math.max(BASE_INNER_H, 1 + workRows * 5 + 4);
}

export function buildOfficeScene(
  overview: AgentOverview,
  nowMs: number,
  unassignedLabel: string,
): OfficeScene {
  const used = new Set<string>();
  const rooms: RoomInput[] = overview.machines.map((machine) => ({
    label: uniqueLabel(machine.name, used),
    agents: machine.agents,
  }));
  if (overview.unassignedAgents.length > 0) {
    rooms.push({ label: uniqueLabel(unassignedLabel, used), agents: overview.unassignedAgents });
  }
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

  const rows = 2 + Math.max(...rooms.map((room) => innerHeight(room.agents)));
  const cols = 1 + rooms.length * ROOM_STRIDE;
  const tiles: TileType[] = Array.from({ length: cols * rows }, () => TileType.WALL);
  const tileColors: OfficeLayout["tileColors"] = Array.from({ length: cols * rows }, () => null);
  const areaTiles: Array<string | null> = Array.from({ length: cols * rows }, () => null);
  const furniture: OfficeLayout["furniture"] = [];
  const placements: OfficePlacement[] = [];

  rooms.forEach((room, index) => {
    const roomMinCol = 1 + index * ROOM_STRIDE;
    const roomMaxCol = roomMinCol + INNER_W - 1;
    const floor = index % 2 === 0 ? TileType.FLOOR_1 : TileType.FLOOR_2;
    const color = FLOOR_COLORS[index % FLOOR_COLORS.length];
    for (let row = 1; row < rows - 1; row += 1) {
      for (let col = roomMinCol; col <= roomMaxCol; col += 1) {
        const at = row * cols + col;
        tiles[at] = floor;
        tileColors[at] = color;
        areaTiles[at] = room.label;
      }
    }
    if (index < rooms.length - 1) {
      const doorCol = roomMaxCol + 1;
      for (const doorRow of [6, 7]) {
        if (doorRow >= rows - 1) continue;
        const at = doorRow * cols + doorCol;
        tiles[at] = floor;
        tileColors[at] = color;
        areaTiles[at] = room.label;
      }
    }
    placeAgents(room.agents, roomMinCol, roomMaxCol, nowMs, furniture, placements);
  });

  const structureKey = rooms
    .map((room) => `${room.label}:${room.agents.map((agent) => `${agent.id}:${agent.presence}`).join(",")}`)
    .join("|");

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
  nowMs: number,
  furniture: OfficeLayout["furniture"],
  placements: OfficePlacement[],
): void {
  let workSlot = 0;
  let offlineSlot = 0;
  let idleSlot = 0;
  for (const agent of agents) {
    const tier = durationTier(agent.presence, presenceDurationMs(agent.presenceSince, nowMs));
    const activity = agent.activityDetail?.trim() || agent.activity;
    if (agent.presence === "working") {
      const col = roomMinCol + 2 + (workSlot % 2) * 5;
      const row = 1 + Math.floor(workSlot / 2) * 5;
      const seatId = `chair-${agent.id}`;
      furniture.push(
        { uid: seatId, type: "WOODEN_CHAIR_FRONT", col, row },
        { uid: `desk-${agent.id}`, type: "DESK_FRONT", col: col - 1, row: row + 2 },
      );
      placements.push({
        agentId: agent.id,
        name: agent.name,
        presence: agent.presence,
        tier,
        activity,
        roomMinCol,
        roomMaxCol,
        seatId,
        anchorCol: col,
        anchorRow: row + 1,
        spawnCol: col,
        spawnRow: row + 1,
      });
      workSlot += 1;
      continue;
    }
    if (agent.presence === "offline") {
      const col = roomMinCol + 1 + (offlineSlot % 3) * 4;
      const row = 12;
      const seatId = `sofa-${agent.id}`;
      furniture.push({ uid: seatId, type: "SOFA_FRONT", col, row });
      placements.push({
        agentId: agent.id,
        name: agent.name,
        presence: agent.presence,
        tier,
        activity,
        roomMinCol,
        roomMaxCol,
        seatId,
        anchorCol: col,
        anchorRow: row,
        spawnCol: col,
        spawnRow: row,
      });
      offlineSlot += 1;
      continue;
    }
    const col = roomMinCol + 3 + (idleSlot % 4) * 2;
    const row = 8;
    placements.push({
      agentId: agent.id,
      name: agent.name,
      presence: agent.presence,
      tier,
      activity,
      roomMinCol,
      roomMaxCol,
      seatId: null,
      anchorCol: col,
      anchorRow: row,
      spawnCol: col,
      spawnRow: row,
    });
    idleSlot += 1;
  }
}
