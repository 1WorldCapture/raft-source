import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BundledComputer } from "./bundledInstall.js";

/** Subpath inside `<resources>` that holds the Computer binary and its version file (packaging: PR 4). */
export const BUNDLED_COMPUTER_SUBPATH = "computer";
export const BUNDLED_COMPUTER_VERSION_FILE = "version.txt";

/**
 * Where the packaged app carries the Computer files. Dev (unpackaged) builds and builds that were
 * packaged before the Computer was bundled report nothing, so the installer is a no-op there.
 */
export function resolveBundledComputer(input: {
  isPackaged: boolean;
  resourcesPath: string;
  exists?: (target: string) => boolean;
  readText?: (target: string) => string | null;
}): BundledComputer {
  if (!input.isPackaged) return { binaryPath: null, photonWasmPath: null, binaryVersion: null, cursorRoot: null };
  const exists = input.exists ?? existsSync;
  const readText = input.readText ?? ((target: string) => { try { return readFileSync(target, "utf8"); } catch { return null; } });
  const dir = path.join(input.resourcesPath, BUNDLED_COMPUTER_SUBPATH);
  const binary = path.join(dir, process.platform === "win32" ? "raft-computer.exe" : "raft-computer");
  const cursor = path.join(input.resourcesPath, "cursor-sdk");
  const wasm = path.join(dir, "photon_rs_bg.wasm");
  return {
    binaryPath: exists(binary) ? binary : null,
    photonWasmPath: exists(binary) && exists(wasm) ? wasm : null,
    binaryVersion: exists(binary) ? readText(path.join(dir, BUNDLED_COMPUTER_VERSION_FILE))?.trim() || null : null,
    cursorRoot: exists(path.join(cursor, "manifest.json")) ? cursor : null,
  };
}
