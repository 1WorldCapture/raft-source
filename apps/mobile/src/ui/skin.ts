import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN_ID, signalHex, skinById, type SkinId } from "@botiverse/raft-shared/src/skins.ts";

/** The four skin roles. Chrome is the surface; signal is the selected accent. */
export interface SkinRoles {
  id: SkinId;
  chrome: string;
  signal: string;
  /** Signal at 40% alpha. Same recipe as the old yellowSoft. */
  signalSoft: string;
  /** Signal at 25% painted on white. Same recipe as the old yellowPale. */
  signalPale: string;
}

const rolesById = new Map<SkinId, SkinRoles>();

export function skinRoles(id: string = DEFAULT_SKIN_ID): SkinRoles {
  const skin = skinById(id);
  const cached = rolesById.get(skin.id);
  if (cached) return cached;
  const signal = signalHex(skin.chrome);
  const roles: SkinRoles = {
    id: skin.id,
    chrome: skin.chrome,
    signal,
    signalSoft: hexAlpha(signal, 0.4),
    signalPale: mixOnWhite(signal, 0.25),
  };
  rolesById.set(skin.id, roles);
  return roles;
}

let currentId: SkinId = DEFAULT_SKIN_ID;
const listeners = new Set<() => void>();

export function getSkinId(): SkinId {
  return currentId;
}

export function setSkin(id: string): void {
  const next = skinById(id).id;
  if (next === currentId) return;
  currentId = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSkin(): SkinRoles {
  const id = useSyncExternalStore(subscribe, getSkinId, getSkinId);
  return skinRoles(id);
}

const styleCache = new WeakMap<(skin: SkinRoles) => unknown, Map<SkinId, unknown>>();

/** Build a StyleSheet once per skin. `build` must be a stable module-level function. */
export function useSkinStyles<T>(build: (skin: SkinRoles) => T): T {
  const skin = useSkin();
  let bySkin = styleCache.get(build);
  if (!bySkin) {
    bySkin = new Map();
    styleCache.set(build, bySkin);
  }
  const hit = bySkin.get(skin.id);
  if (hit) return hit as T;
  const created = build(skin);
  bySkin.set(skin.id, created);
  return created;
}

function hexAlpha(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixOnWhite(hex: string, amount: number): string {
  const [r, g, b] = channels(hex);
  const mix = (channel: number) => Math.round(channel * amount + 255 * (1 - amount));
  return `#${[mix(r), mix(g), mix(b)].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
