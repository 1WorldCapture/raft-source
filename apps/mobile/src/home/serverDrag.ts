// Pure geometry for long-press reorder in the top-bar server list.
// Kept out of the component so the drop result is unit-testable.

/** How long a press must be held before the row becomes a drag. */
export const DRAG_ACTIVATE_MS = 350;

/** Index of the slot whose center is closest to `centerY`. */
export function nearestSlotIndex(
  slots: readonly { y: number; height: number }[],
  centerY: number,
): number {
  if (slots.length === 0) return -1;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  slots.forEach((slot, index) => {
    const distance = Math.abs(slot.y + slot.height / 2 - centerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** Keep the lifted row between the first and last slot. */
export function clampDragDelta(startY: number, rawDy: number, slotTops: readonly number[]): number {
  if (slotTops.length === 0) return rawDy;
  const min = Math.min(...slotTops) - startY;
  const max = Math.max(...slotTops) - startY;
  return Math.min(max, Math.max(min, rawDy));
}

/**
 * Move the id at `from` to `to`. Same index, or an index outside the list,
 * returns a copy of the original order.
 */
export function moveServerIds(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length || from === to) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...ids];
  next.splice(to, 0, moved);
  return next;
}
