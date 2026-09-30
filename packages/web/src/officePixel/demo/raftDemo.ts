import type { Character } from '../office/types.js';
import { CharacterState, Direction, TILE_SIZE } from '../office/types.js';

/** Offline characters stay on the sofa. Returns true when the FSM should skip. */
export function holdDemoCharacter(ch: Character): boolean {
  const demo = ch.demo;
  if (!demo) return false;
  if (demo.presence === 'work') {
    ch.isActive = true;
    ch.bubbleType = null;
    return false;
  }
  if (demo.presence === 'idle' || demo.presence === 'boss') {
    ch.isActive = false;
    ch.bubbleType = null;
    return false;
  }
  ch.isActive = false;
  ch.bubbleType = null;
  ch.path = [];
  ch.state = CharacterState.IDLE;
  ch.dir = Direction.DOWN;
  ch.frame = 0;
  ch.tileCol = demo.anchorCol;
  ch.tileRow = demo.anchorRow;
  ch.x = demo.anchorCol * TILE_SIZE + TILE_SIZE / 2;
  ch.y = demo.anchorRow * TILE_SIZE + TILE_SIZE / 2;
  return true;
}

/**
 * Idle-short stays in its room. Longer idle walks into other rooms,
 * which is how the accepted demo sends people through the door.
 */
export function demoWalkableTiles(
  ch: Character,
  tiles: Array<{ col: number; row: number }>,
): Array<{ col: number; row: number }> {
  const demo = ch.demo;
  if (!demo || demo.presence === 'boss') return tiles;
  if (demo.presence !== 'idle') return tiles;
  if (demo.tier === 0) {
    return tiles.filter((t) => t.col >= demo.roomMinCol && t.col <= demo.roomMaxCol);
  }
  return tiles.filter((t) => t.col < demo.roomMinCol || t.col > demo.roomMaxCol);
}
