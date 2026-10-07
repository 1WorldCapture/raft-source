// Pure scroll geometry for the server rail (#mobile-server-rail task #3), kept
// out of the component so it is unit-testable without React Native.

/** Pixels of slack before an edge counts as "more content that way". */
const EDGE_SLACK = 4;
/** Breathing room kept around the current tile when scrolling it into view. */
const VISIBLE_MARGIN = 12;

export function railOverflow({ offset, viewport, contentHeight }: {
  offset: number;
  viewport: number;
  contentHeight: number;
}): { above: boolean; below: boolean } {
  if (viewport <= 0 || contentHeight <= viewport) return { above: false, below: false };
  return {
    above: offset > EDGE_SLACK,
    below: offset + viewport < contentHeight - EDGE_SLACK,
  };
}

/**
 * Where to scroll so the slot is fully visible, or null when it already is.
 * Scrolls the minimum distance and clamps to the scrollable range.
 */
export function railScrollTargetY({ slot, offset, viewport, contentHeight }: {
  slot: { y: number; height: number };
  offset: number;
  viewport: number;
  contentHeight: number;
}): number | null {
  if (viewport <= 0) return null;
  const maxOffset = Math.max(0, contentHeight - viewport);
  const top = slot.y - VISIBLE_MARGIN;
  const bottom = slot.y + slot.height + VISIBLE_MARGIN;
  let target: number | null = null;
  if (top < offset) target = top;
  else if (bottom > offset + viewport) target = bottom - viewport;
  if (target === null) return null;
  const clamped = Math.min(maxOffset, Math.max(0, target));
  return clamped === offset ? null : clamped;
}
