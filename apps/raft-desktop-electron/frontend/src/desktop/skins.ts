// Desktop skin application.
//
// The palette and the chrome → signal derivation live in
// packages/shared/src/skins.ts so mobile resolves the same colors. This file
// only persists the choice and writes the two root tokens. The neo-brutalist
// structure (ink, hard shadow, borders) does not change.
//
// CHROME (`--color-soft-signal`) is the surface color. SIGNAL is raft-ui's
// brutal-yellow scale re-hued to that chrome: each step keeps its lightness and
// chroma, and only the hue moves. `--color-brutal-yellow` follows step 400.

import {
  chromeChannels,
  DEFAULT_SKIN_ID,
  SIGNAL_SCALE,
  signalStepCss,
  SKINS,
  skinById,
} from "@botiverse/raft-shared/src/skins.ts";

export type { Skin } from "@botiverse/raft-shared/src/skins.ts";
export { DEFAULT_SKIN_ID, SKINS, skinById };

const STORAGE_KEY = "raft-desktop-skin";

export function currentSkinId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_SKIN_ID;
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

export function applySkin(id: string): void {
  const skin = skinById(id);
  const [cr, cg, cb] = chromeChannels(skin.chrome);
  const root = document.documentElement;
  root.dataset.raftSkin = skin.id;
  // Inline styles on <html> outrank the @theme :root / :where(:root) defaults.
  // Chrome (surfaces):
  root.style.setProperty("--color-soft-signal", skin.chrome);
  root.style.setProperty("--soft-signal-rgb", `${cr} ${cg} ${cb}`);
  // Signal (selected/busy): re-hue raft-ui's scale, keeping OKLCH lightness +
  // chroma per step, swapping only the hue to this chrome. `oklch(from …)`
  // relative color does the hue swap with no JS colour maths.
  for (const { step } of SIGNAL_SCALE) {
    root.style.setProperty(`--color-brutal-yellow-${step}`, signalStepCss(skin.chrome, step));
  }
  // The alias + its RGB channels follow the re-hued 400 (raft-ui's canonical
  // fill), so both scale-based (raft-ui) and alias-based (web `bg-brutal-yellow`,
  // plus the baked alpha variants rebound in index.css) usages re-skin together.
  root.style.setProperty("--color-brutal-yellow", "var(--color-brutal-yellow-400)");
  root.style.setProperty("--brutal-yellow-rgb", `${cr} ${cg} ${cb}`);
}

// One shared "current skin" so every surface (top-bar switcher, Settings →
// Appearance) stays in sync from a single source.
const listeners = new Set<(id: string) => void>();
export function subscribeSkin(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSkin(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the skin still applies for this session.
  }
  applySkin(id);
  for (const listener of listeners) listener(id);
}

export function initSkin(): void {
  applySkin(currentSkinId());
}

// Skin lives only in the desktop top bar (DesktopTopBar's SkinSwitcher), by
// @WAWQAQ's call (2026-09-09): Settings does not need a skin control. An earlier
// installSkinBridge published a global for a reused-web Settings panel that never
// consumed it — removed so no dead seam remains.
