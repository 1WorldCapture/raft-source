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
// process before the window is created, and only after this process holds
// the single-instance lock. It is always logged — to the console AND to
// <userData>/storage-doctor.log, because a packaged app has no console and
// a forced re-login otherwise leaves nothing to debug.

import { rmSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export const STORAGE_WIPE_MARKER_NAME = "storage-wipe-pending";
export const STORAGE_DOCTOR_LOG_NAME = "storage-doctor.log";
const LOCAL_STORAGE_DIR_NAME = "Local Storage";

export type StorageDoctorDeps = {
  existsSync?: (p: string) => boolean;
  rmSync?: (p: string, options: { recursive: true; force: true }) => void;
  writeFileSync?: (p: string, data: string) => void;
  appendFileSync?: (p: string, data: string) => void;
  log?: (message: string) => void;
};

export function localStorageDir(userDataPath: string): string {
  return path.join(userDataPath, LOCAL_STORAGE_DIR_NAME);
}

export function wipeMarkerPath(userDataPath: string): string {
  return path.join(userDataPath, STORAGE_WIPE_MARKER_NAME);
}

function doctorLogPath(userDataPath: string): string {
  return path.join(userDataPath, STORAGE_DOCTOR_LOG_NAME);
}

function makeLogger(userDataPath: string, deps: StorageDoctorDeps): (message: string) => void {
  const fallback = deps.log ?? ((message: string) => console.log(message));
  const append = deps.appendFileSync ?? appendFileSync;
  return (message: string) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fallback(message);
    try {
      append(doctorLogPath(userDataPath), line);
    } catch {
      // The userData dir may not be writable at this stage; the console copy
      // above is the remaining breadcrumb.
    }
  };
}

/**
 * Boot-time half: consume a pending wipe marker and delete the Local Storage
 * directory BEFORE any session/storage is opened. The directory is removed
 * FIRST and the marker only after that succeeded, so a locked file (EBUSY on
 * Windows, a stubborn holder elsewhere) retries on the next boot instead of
 * silently skipping the wipe. Returns true when a wipe happened (the
 * renderer asks for this via the storageWipeStatus channel to skip the
 * corruption heuristic for that one boot).
 */
export function resolvePendingStorageWipe(userDataPath: string, deps: StorageDoctorDeps = {}): boolean {
  const exists = deps.existsSync ?? existsSync;
  const rm = deps.rmSync ?? rmSync;
  const log = makeLogger(userDataPath, deps);

  const marker = wipeMarkerPath(userDataPath);
  if (!exists(marker)) return false;
  const dir = localStorageDir(userDataPath);
  const hadDir = exists(dir);
  if (hadDir) {
    try {
      rm(dir, { recursive: true, force: true });
    } catch (error) {
      // Leave the marker in place so the next boot retries; crashing at
      // module scope would be strictly worse than one more corrupted boot.
      log(`[raft-desktop] storage doctor: Local Storage removal failed (${String(error)}); will retry next boot`);
      return false;
    }
  }
  try {
    rm(marker, { recursive: true, force: true });
  } catch (error) {
    log(`[raft-desktop] storage doctor: marker removal failed (${String(error)})`);
  }
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
  const log = makeLogger(userDataPath, deps);
  write(wipeMarkerPath(userDataPath), String(Date.now()));
  log("[raft-desktop] storage doctor: corruption detected by renderer; scheduled Local Storage wipe and relaunch");
  relaunch();
  exit(0);
}
