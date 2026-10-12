// Publishes the top-bar search field's geometry as the CSS variables the ⌘K
// overlay anchors to (see packages/web/src/components/search/searchOverlayAnchor.ts):
// the overlay's top edge sits on the field's top edge, centred on it, so the
// panel reads as the field expanding. Without these variables the overlay falls
// back to its centred placement.
import { DESKTOP_SEARCH_ANCHOR_VARS } from "../../../../../packages/web/src/components/search/searchOverlayAnchor.ts";

type Rect = Pick<DOMRect, "top" | "left" | "width">;

export function writeSearchAnchor(root: HTMLElement, rect: Rect): void {
  root.style.setProperty(DESKTOP_SEARCH_ANCHOR_VARS.top, `${Math.round(rect.top)}px`);
  root.style.setProperty(DESKTOP_SEARCH_ANCHOR_VARS.centerX, `${Math.round(rect.left + rect.width / 2)}px`);
  root.style.setProperty(DESKTOP_SEARCH_ANCHOR_VARS.width, `${Math.round(rect.width)}px`);
}

export function clearSearchAnchor(root: HTMLElement): void {
  for (const name of Object.values(DESKTOP_SEARCH_ANCHOR_VARS)) root.style.removeProperty(name);
}

/** Keeps the variables in sync with the element until the returned cleanup runs. */
export function trackSearchAnchor(element: HTMLElement, root: HTMLElement = document.documentElement): () => void {
  const update = () => writeSearchAnchor(root, element.getBoundingClientRect());
  update();
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  observer?.observe(element);
  window.addEventListener("resize", update);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", update);
    clearSearchAnchor(root);
  };
}
