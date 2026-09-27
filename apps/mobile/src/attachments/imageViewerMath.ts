/** ImageViewer gesture math: zoom bounds, double-tap toggle, and pan clamping
 *  so a zoomed image cannot be dragged past its edges. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.5;
/** Swipe-down displacement (dp) past which the viewer closes. */
export const DISMISS_THRESHOLD = 140;

export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** Double tap toggles between 1x and the fixed zoom-in level. */
export function nextDoubleTapZoom(scale: number): number {
  return scale > 1.01 ? MIN_ZOOM : DOUBLE_TAP_ZOOM;
}

/** Pan offsets are clamped to the over-scroll rectangle of the scaled image. */
export function clampOffset(offset: number, scale: number, viewport: number): number {
  if (scale <= MIN_ZOOM) return 0;
  const limit = (viewport * (scale - MIN_ZOOM)) / 2;
  return Math.min(limit, Math.max(-limit, offset));
}

/** Vertical-dominant drags dismiss; horizontal ones belong to pagination. */
export function isDismissSwipe(translationX: number, translationY: number): boolean {
  return translationY > DISMISS_THRESHOLD && Math.abs(translationY) > Math.abs(translationX);
}
