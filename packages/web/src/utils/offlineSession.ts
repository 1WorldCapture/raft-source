// Offline cold-start admission (desktop-data-cache task #17 / P2d).
//
// A network-unreachable /auth/me (no HTTP status) must not trap the app on
// "Restoring session…". When this browser already has an access token and the
// last signed-in profile matches the cache scope #7 persisted, the shell can
// enter read-only with that identity and keep retrying in the background.
// Any HTTP status — 401/403 included — is not this path.

import { hasPlaceholderHandle } from "@botiverse/raft-shared";
import { WEB_CACHE_LAST_SCOPE_KEY } from "../cache/webCacheLifecycle";
import type { User } from "../store/authStore";

/** Public profile from the last successful /auth/me. Never stores tokens. */
export const OFFLINE_USER_SNAPSHOT_KEY = "raft_web_offline_user";

export type ScopeIdentity = { userId: string; serverId: string };

type StorageReader = { getItem(key: string): string | null };
type StorageWriter = { setItem(key: string, value: string): void; removeItem(key: string): void };

export function parseScopeIdentity(raw: string | null): ScopeIdentity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; serverId?: unknown };
    if (
      typeof parsed.userId === "string" && parsed.userId
      && typeof parsed.serverId === "string" && parsed.serverId
    ) {
      return { userId: parsed.userId, serverId: parsed.serverId };
    }
  } catch {
    return null;
  }
  return null;
}

export function parseOfflineUser(raw: string | null): User | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<User> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || !parsed.id) return null;
    if (typeof parsed.email !== "string") return null;
    if (typeof parsed.name !== "string" || !parsed.name) return null;
    if (hasPlaceholderHandle(parsed.name)) return null;
    if (parsed.emailVerified !== true) return null;
    return parsed as User;
  } catch {
    return null;
  }
}

/**
 * Admit only when the server never answered. A numeric status (401, 403, 5xx)
 * stays on the existing logout or restoring-session path.
 */
export function decideOfflineAdmission(input: {
  status: number | undefined;
  hasAccessToken: boolean;
  scope: ScopeIdentity | null;
  user: User | null;
}): { user: User; serverId: string } | null {
  if (typeof input.status === "number") return null;
  if (!input.hasAccessToken) return null;
  if (!input.scope || !input.user) return null;
  if (input.user.id !== input.scope.userId) return null;
  return { user: input.user, serverId: input.scope.serverId };
}

export function readOfflineAdmission(
  status: number | undefined,
  hasAccessToken: boolean,
  storage: StorageReader,
): { user: User; serverId: string } | null {
  return decideOfflineAdmission({
    status,
    hasAccessToken,
    scope: parseScopeIdentity(storage.getItem(WEB_CACHE_LAST_SCOPE_KEY)),
    user: parseOfflineUser(storage.getItem(OFFLINE_USER_SNAPSHOT_KEY)),
  });
}

export function rememberOfflineUser(user: User, storage: StorageWriter): void {
  try {
    storage.setItem(OFFLINE_USER_SNAPSHOT_KEY, JSON.stringify(user));
  } catch {
    // Best-effort. Without a snapshot the next offline boot stays on the
    // restoring screen instead of inventing an identity.
  }
}

export function forgetOfflineUser(storage: StorageWriter): void {
  try {
    storage.removeItem(OFFLINE_USER_SNAPSHOT_KEY);
  } catch {
    // ignore
  }
}

// Mirrors authStore.offlineReadonly without importing the store. messageStore
// reads this after a failed fetch; importing authStore there evaluates
// localStorage at module init and breaks node tests.
let offlineReadonlyActive = false;

export function setOfflineReadonlyActive(active: boolean): void {
  offlineReadonlyActive = active;
}

export function isOfflineReadonlyActive(): boolean {
  return offlineReadonlyActive;
}
