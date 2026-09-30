// Offline cold-start admission (desktop-data-cache task #17 / P2d).
//
// A network-unreachable /auth/me (no HTTP status) must not trap the app on
// "Restoring session…". When this browser still holds a complete stored
// session (access + refresh), the access token's subject is the snapshotted
// user, and that user matches the cache scope #7 persisted, the shell can
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
    return parseOfflineUserValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Same validation as parseOfflineUser, for an already-parsed value — the
 * IndexedDB backup row (task #12) stores the snapshot as an object.
 */
export function parseOfflineUserValue(value: unknown): User | null {
  const parsed = value as Partial<User> | null;
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.id !== "string" || !parsed.id) return null;
  if (typeof parsed.email !== "string") return null;
  if (typeof parsed.name !== "string" || !parsed.name) return null;
  if (hasPlaceholderHandle(parsed.name)) return null;
  if (parsed.emailVerified !== true) return null;
  return parsed as User;
}

/**
 * Admit only when the server never answered. A numeric status (401, 403, 5xx)
 * stays on the existing logout or restoring-session path. The access token's
 * subject must be the snapshotted user — a token issued to another account
 * (e.g. a login that never completed /auth/me before going offline) must not
 * read this snapshot's identity or cache.
 */
export function decideOfflineAdmission(input: {
  status: number | undefined;
  hasStoredSession: boolean;
  tokenSubject: string | null;
  scope: ScopeIdentity | null;
  user: User | null;
}): { user: User; serverId: string } | null {
  if (typeof input.status === "number") return null;
  if (!input.hasStoredSession) return null;
  if (!input.scope || !input.user) return null;
  if (input.user.id !== input.scope.userId) return null;
  if (input.tokenSubject !== input.user.id) return null;
  return { user: input.user, serverId: input.scope.serverId };
}

export function readOfflineAdmission(
  status: number | undefined,
  hasStoredSession: boolean,
  storage: StorageReader,
  tokenSubject: string | null,
): { user: User; serverId: string } | null {
  return decideOfflineAdmission({
    status,
    hasStoredSession,
    tokenSubject,
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

/**
 * Drop the snapshot when the access token's subject is a different account.
 * Tokens can rotate to another user without a /auth/me in between (an OAuth
 * login cut short by going offline, a forced 401 clear that skips the logout
 * wrapper); the previous user's snapshot must not survive into the new
 * account's offline boot. A null subject (opaque/unparseable token) clears
 * nothing — admission independently rejects it.
 */
export function forgetOfflineUserOnSubjectChange(
  tokenSubject: string | null,
  storage: StorageReader & StorageWriter,
): void {
  if (!tokenSubject) return;
  const snapshot = parseOfflineUser(storage.getItem(OFFLINE_USER_SNAPSHOT_KEY));
  if (snapshot && snapshot.id !== tokenSubject) forgetOfflineUser(storage);
}
