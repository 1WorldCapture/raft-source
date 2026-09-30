// Storage doctor (desktop-data-cache task #12).
//
// Chromium's localStorage lives in a LevelDB journal that only guarantees
// durability at graceful shutdown. A hard kill (force quit, crash, power
// loss) can tear a commit block; once the journal is torn, every later boot
// recovers it by DROPPING bytes, so each session's writes (login tokens
// included) are silently lost at the next launch — a self-sustaining loop
// observed with a LevelDB LOG line "Corruption: checksum mismatch … dropping
// N bytes". Deleting the Local Storage directory breaks the loop; IndexedDB
// (message cache) is a separate database and is left untouched.
//
// The wipe MUST happen before any renderer opens storage, i.e. in the main
// process before the window is created. It is always logged.

import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const STORAGE_WIPE_MARKER_NAME = "storage-wipe-pending";
const LOCAL_STORAGE_DIR_NAME = "Local Storage";

export type StorageDoctorDeps = {
  existsSync?: (p: string) => boolean;
  rmSync?: (p: string, options: { recursive: true; force: true }) => void;
  writeFileSync?: (p: string, data: string) => void;
  log?: (message: string) => void;
};

export function localStorageDir(userDataPath: string): string {
  return path.join(userDataPath, LOCAL_STORAGE_DIR_NAME);
}

export function wipeMarkerPath(userDataPath: string): string {
  return path.join(userDataPath, STORAGE_WIPE_MARKER_NAME);
}

/**
 * Boot-time half: consume a pending wipe marker and delete the Local Storage
 * directory BEFORE any session/storage is opened. Returns true when a wipe
 * happened (the renderer asks for this via the storageWipeStatus channel to
 * skip the corruption heuristic for that one boot).
 */
export function resolvePendingStorageWipe(userDataPath: string, deps: StorageDoctorDeps = {}): boolean {
  const exists = deps.existsSync ?? existsSync;
  const rm = deps.rmSync ?? rmSync;
  const log = deps.log ?? ((message: string) => console.log(message));

  const marker = wipeMarkerPath(userDataPath);
  if (!exists(marker)) return false;
  rm(marker, { recursive: true, force: true });
  const dir = localStorageDir(userDataPath);
  const hadDir = exists(dir);
  if (hadDir) rm(dir, { recursive: true, force: true });
  log(`[raft-desktop] storage doctor: wiped Local Storage (hadDir=${hadDir}) to break a corrupted-journal write-loss loop`);
  return true;
}

/**
 * Renderer-requested half: schedule the wipe for the NEXT boot (a marker
 * file, plain fs — immune to the LevelDB corruption itself) and relaunch.
 * The current process must exit for the wipe to happen before storage opens.
 */
export function requestStorageWipeAndRelaunch(
  userDataPath: string,
  relaunch: () => void,
  exit: (code: number) => void,
  deps: StorageDoctorDeps = {},
): void {
  const write = deps.writeFileSync ?? writeFileSync;
  const log = deps.log ?? ((message: string) => console.log(message));
  write(wipeMarkerPath(userDataPath), String(Date.now()));
  log("[raft-desktop] storage doctor: corruption detected by renderer; scheduled Local Storage wipe and relaunch");
  relaunch();
  exit(0);
}
