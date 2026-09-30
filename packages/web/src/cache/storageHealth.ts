// Storage health canary (desktop-data-cache task #12).
//
// Chromium's localStorage journal can enter a self-sustaining write-loss
// loop after a hard kill tears a commit block: every boot drops that
// session's writes (login tokens included). Existence of the canary key is
// NOT enough — a profile that already ran this build keeps reading an OLD
// canary value while every newer write is dropped, so the loop would never
// be detected. Instead each boot writes a monotonically increasing SESSION
// ID into the canary, and — after a delay well past Chromium's commit
// window — into the IndexedDB backup. The next boot compares:
//
//   localStorage canary  <  IndexedDB session id   →  writes were dropped
//                                                        (corruption loop)
//   localStorage canary  >= IndexedDB session id   →  healthy
//
// A session killed before the delayed IndexedDB record leaves the backup
// pointing at the PREVIOUS session, so "localStorage newer than backup" is
// the healthy direction and never wipes. No backup row at all (fresh
// profile, right after logout, or the first boots after upgrading to this
// build) also never wipes.

export const WEB_STORAGE_CANARY_KEY = "raft_web_boot_canary";
/** How long a session must survive before its id is recorded as durable. */
export const CANARY_RECORD_DELAY_MS = 15_000;

export type StorageHealthInput = {
  /** Session id in the localStorage canary (null when the key is gone). */
  canaryValue: number | null;
  /** Last durably recorded session id from the IndexedDB backup. */
  backupSessionId: number | null;
  /** Did this boot already consume a pending Local Storage wipe? */
  justWiped: boolean;
};

export function shouldWipeLocalStorage(input: StorageHealthInput): boolean {
  if (input.justWiped) return false;
  if (input.backupSessionId === null) return false;
  if (input.canaryValue === null) return true;
  return input.canaryValue < input.backupSessionId;
}

/** The session id this boot adopted (max of both copies, +1). */
export function nextSessionId(canaryValue: number | null, backupSessionId: number | null): number {
  return Math.max(canaryValue ?? -1, backupSessionId ?? -1) + 1;
}

export function parseCanaryValue(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export type CanaryStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

/** The session id adopted by THIS boot's health check. */
let currentSession: number | null = null;

/** Write (or refresh) the canary with this session's id. */
export function touchStorageCanary(storage: { setItem(key: string, value: string): void }): void {
  if (currentSession === null) return;
  try {
    storage.setItem(WEB_STORAGE_CANARY_KEY, String(currentSession));
  } catch {
    // Best-effort: with storage disabled the next boot simply sees the
    // backup-only shape, which never wipes.
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

export type HealthDeps = {
  storage: CanaryStorage;
  backupSessionId: number | null;
  recordBackupSessionId?: (sessionId: number) => void;
  recordDelayMs?: number;
};

/**
 * Boot-time check. Returns "wipe-requested" when corruption was detected and
 * the desktop shell accepted the relaunch request (the process is about to
 * exit — callers should stop booting); "healthy" otherwise, after adopting
 * and writing this session's canary. In a plain browser there is no bridge:
 * we log and continue — the loop then persists until the user clears site
 * data, which is the pre-existing browser behavior and out of scope here.
 */
export async function runStorageHealthCheck(deps: HealthDeps): Promise<"healthy" | "wipe-requested"> {
  const bridge = desktopStorageBridge();
  let justWiped = false;
  if (bridge?.justWiped) {
    try {
      justWiped = await bridge.justWiped();
    } catch {
      justWiped = false;
    }
  }
  const canaryValue = parseCanaryValue(deps.storage.getItem(WEB_STORAGE_CANARY_KEY));
  if (shouldWipeLocalStorage({ canaryValue, backupSessionId: deps.backupSessionId, justWiped })) {
    if (bridge?.resetAndRelaunch) {
      bridge.resetAndRelaunch();
      return "wipe-requested";
    }
    console.error("[raft] localStorage canary is older than the durable backup — storage likely corrupted; clear site data to recover");
    // Fall through: still adopt a fresh session id so the next boot does not
    // re-report the same incident.
  }
  currentSession = nextSessionId(canaryValue, deps.backupSessionId);
  touchStorageCanary(deps.storage);
  // Record durability only after the session has outlived the commit window;
  // a session that dies early leaves the backup on the previous id, which is
  // the healthy direction of the comparison above.
  const session = currentSession;
  const timer = setTimeout(() => {
    deps.recordBackupSessionId?.(session);
  }, deps.recordDelayMs ?? CANARY_RECORD_DELAY_MS);
  // The record is advisory; never keep the event loop alive just for it.
  if (typeof timer === "object" && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
  return "healthy";
}
