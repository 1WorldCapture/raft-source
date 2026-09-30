import { CharacterState, Direction, TILE_SIZE } from "../officePixel/office/types.js";
import type { OfficeState } from "../officePixel/office/engine/officeState.js";
import type { OfficePlacement, OfficeScene } from "./roomLayout";

const numericIds = new Map<string, number>();
const agentIds = new Map<number, string>();
let nextNumericId = 1;

export function numericAgentId(agentId: string): number {
  const existing = numericIds.get(agentId);
  if (existing !== undefined) return existing;
  const id = nextNumericId;
  nextNumericId += 1;
  numericIds.set(agentId, id);
  agentIds.set(id, agentId);
  return id;
}

export function raftAgentId(numericId: number): string | null {
  return agentIds.get(numericId) ?? null;
}

function demoOf(placement: OfficePlacement) {
  return {
    name: placement.name,
    presence: placement.presence === "working" ? "work" as const : placement.presence,
    tier: placement.tier,
    roomMinCol: placement.roomMinCol,
    roomMaxCol: placement.roomMaxCol,
    anchorCol: placement.anchorCol,
    anchorRow: placement.anchorRow,
    activity: placement.activity,
    avoidCols: placement.avoidCols,
    highlighted: placement.highlighted,
  };
}

function placeWalking(os: OfficeState, placement: OfficePlacement, palette: number): void {
  const id = numericAgentId(placement.agentId);
  os.addAgent(id, palette % 6, 0, undefined, true);
  const ch = os.characters.get(id);
  if (!ch) return;
  ch.seatId = null;
  ch.isActive = false;
  ch.state = CharacterState.IDLE;
  ch.dir = Direction.DOWN;
  ch.path = [];
  ch.tileCol = placement.spawnCol;
  ch.tileRow = placement.spawnRow;
  ch.x = placement.spawnCol * TILE_SIZE + TILE_SIZE / 2;
  ch.y = placement.spawnRow * TILE_SIZE + TILE_SIZE / 2;
  ch.demo = demoOf(placement);
}

/** Paint placements onto the canvas state. Rebuilds seats only when the room structure changes. */
export function paintOffice(os: OfficeState, scene: OfficeScene, previousKey: string | null): string {
  if (previousKey === scene.structureKey) {
    for (const placement of scene.placements) {
      const ch = os.characters.get(numericAgentId(placement.agentId));
      if (!ch) continue;
      ch.demo = demoOf(placement);
    }
    return scene.structureKey;
  }

  os.characters.clear();
  os.selectedAgentId = null;
  os.cameraFollowId = null;
  os.hoveredAgentId = null;
  os.rebuildFromLayout(scene.layout);

  const seated = scene.placements.filter((placement) => placement.seatId);
  const walking = scene.placements.filter((placement) => !placement.seatId);
  seated.forEach((placement, index) => {
    const id = numericAgentId(placement.agentId);
    os.addAgent(id, index % 6, placement.presence === "offline" ? 50 : 0, placement.seatId ?? undefined, true);
    const ch = os.characters.get(id);
    if (ch) ch.demo = demoOf(placement);
  });
  for (const seat of os.seats.values()) seat.assigned = true;
  walking.forEach((placement, index) => placeWalking(os, placement, seated.length + index));
  return scene.structureKey;
}
