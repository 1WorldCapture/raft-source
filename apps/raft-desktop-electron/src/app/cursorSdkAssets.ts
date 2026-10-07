/**
 * Cursor SDK runtime-asset wiring for the packaged desktop host.
 *
 * The `cursor-sdk` daemon runtime MUST NOT import @cursor/sdk inside the
 * Electron process. Instead the app ships a self-contained asset root (staged
 * by packages/daemon/scripts/build-cursor-sdk-assets.mjs, pinned by
 * packages/daemon/cursor-sdk-assets.lock.json) as extraResources at
 * `<resources>/cursor-sdk`, containing:
 *
 *   manifest.json, node/ (official Node 24.15.0),
 *   node_modules/ (@cursor/sdk 1.0.36 + full production closure), host/*.mjs.
 *
 * The daemon resolves assets ONLY from the host-owner env
 * RAFT_CURSOR_SDK_ASSETS (packages/daemon/src/cursorSdk/assets.ts), so this
 * module's whole job is to compute that value from `process.resourcesPath`
 * before the daemon is imported. The detached `__service`/`__run` children
 * inherit the env, so setting it once at main-module scope covers every
 * daemon the app ever spawns. Dev (unpackaged) builds leave it unset and the
 * daemon discovers `packages/daemon/runtime-assets/cursor/<version>/<target>`.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** Location of the staged assets inside the packaged app's resources dir. */
export const CURSOR_SDK_RESOURCES_SUBPATH = "cursor-sdk";

export interface BundledCursorSdkAssets {
  /** Absolute asset root to set as RAFT_CURSOR_SDK_ASSETS, or null. */
  root: string | null;
  /** true when packaged but the bundled assets are absent (install is broken). */
  missing: boolean;
}

/**
 * Pure seam over the packaged-asset lookup. `resourcesPath` is
 * `process.resourcesPath` in the Electron main process.
 */
export function resolveBundledCursorSdkAssets(input: {
  isPackaged: boolean;
  resourcesPath: string;
  exists?: (p: string) => boolean;
}): BundledCursorSdkAssets {
  if (!input.isPackaged) return { root: null, missing: false };
  const root = path.join(input.resourcesPath, CURSOR_SDK_RESOURCES_SUBPATH);
  const manifestExists = (input.exists ?? existsSync)(path.join(root, "manifest.json"));
  return manifestExists ? { root, missing: false } : { root: null, missing: true };
}
