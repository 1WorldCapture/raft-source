// Storage health canary (desktop-data-cache task #12).
//
// Chromium's localStorage journal can enter a self-sustaining write-loss
// loop after a hard kill tears a commit block: every boot drops that
// session's writes (login tokens included). Detection without reading the
// LevelDB itself: a canary key written on EVERY boot. If a boot finds the
// canary missing while the IndexedDB cache clearly holds prior data, the
// previous boot's writes were dropped → localStorage is corrupted → ask the
// desktop shell to wipe Local Storage at next boot and relaunch.
//
// Deliberate non-triggers:
//   - first run / fresh profile: IndexedDB is also empty → no wipe;
//   - user-cleared site data: clears IndexedDB too → no wipe;
//   - the boot right after a wipe (justWiped): expected missing canary.

export const WEB_STORAGE_CANARY_KEY = "raft_web_boot_canary";

export type StorageHealthInput = {
  /** Can the canary written by the previous boot still be read? */
  canaryPresent: boolean;
  /** Does the IndexedDB cache hold identity data from earlier sessions? */
  cacheHasIdentity: boolean;
  /** Did this boot already consume a pending Local Storage wipe? */
  justWiped: boolean;
};

export function shouldWipeLocalStorage(input: StorageHealthInput): boolean {
  if (input.justWiped) return false;
  return !input.canaryPresent && input.cacheHasIdentity;
}

/** Write (or refresh) the canary the NEXT boot expects to find. */
export function touchStorageCanary(storage: { setItem(key: string, value: string): void }): void {
  try {
    storage.setItem(WEB_STORAGE_CANARY_KEY, String(Date.now()));
  } catch {
    // Best-effort: a browser with storage disabled simply re-checks as a
    // "first run" next boot, and cacheHasIdentity gates any wipe.
  }
}

type DesktopStorageBridge = {
  justWiped?: () => Promise<boolean>;
  resetAndRelaunch?: () => void;
};

function desktopStorageBridge(): DesktopStorageBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as { raftDesktop?: { storage?: DesktopStorageBridge } }).raftDesktop?.storage;
  return bridge && typeof bridge.resetAndRelaunch === "function" ? bridge : null;
}

/**
 * Boot-time check. Returns "wipe-requested" when corruption was detected and
 * the desktop shell accepted the relaunch request (the process is about to
 * exit — callers should stop booting); "healthy" otherwise, after refreshing
 * the canary. In a plain browser there is no bridge: we log and continue —
 * the loop then persists until the user clears site data, which is the
 * pre-existing browser behavior and out of scope here.
 */
export async function runStorageHealthCheck(opts: {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  cacheHasIdentity: boolean;
}): Promise<"healthy" | "wipe-requested"> {
  const bridge = desktopStorageBridge();
  let justWiped = false;
  if (bridge?.justWiped) {
    try {
      justWiped = await bridge.justWiped();
    } catch {
      justWiped = false;
    }
  }
  const canaryPresent = opts.storage.getItem(WEB_STORAGE_CANARY_KEY) !== null;
  if (shouldWipeLocalStorage({ canaryPresent, cacheHasIdentity: opts.cacheHasIdentity, justWiped })) {
    if (bridge?.resetAndRelaunch) {
      bridge.resetAndRelaunch();
      return "wipe-requested";
    }
    console.error("[raft] localStorage canary lost while cache has data — storage likely corrupted; clear site data to recover");
    // Fall through: refresh the canary so the next boot does not re-report.
  }
  touchStorageCanary(opts.storage);
  return "healthy";
}
