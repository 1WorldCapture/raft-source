// Sender-directory cache (#desktop-data-cache task #3): the minimal fields
// avatar rendering needs (sender id → avatarUrl / display name) come from
// GET /agents + GET /servers/:id/members and are NOT part of message
// payloads — offline, message rows fell back to letters. Persisted as one kv
// snapshot per scope; pixel: avatar urls render fully offline (bundled
// sprites), https urls degrade through the Avatar photo fallback.
import type { CacheRepo } from "./repo";

const KEY = "senderDirectory";

export interface SenderDirectory {
  /** sender id → avatar url, merged from agents (id) and members (userId). */
  avatars: Record<string, string>;
  /** sender id → display name (agents and members). */
  names: Record<string, string>;
}

function decode(value: unknown): SenderDirectory | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as { avatars?: unknown; names?: unknown };
  if (typeof record.avatars !== "object" || record.avatars === null || typeof record.names !== "object" || record.names === null) return null;
  const avatars: Record<string, string> = {};
  for (const [id, url] of Object.entries(record.avatars)) {
    if (typeof url === "string" && url) avatars[id] = url;
  }
  const names: Record<string, string> = {};
  for (const [id, name] of Object.entries(record.names)) {
    if (typeof name === "string" && name) names[id] = name;
  }
  return { avatars, names };
}

/** Read the cached directory; absent or malformed degrades to null. */
export function readSenderDirectory(repo: CacheRepo, scopeId: number): SenderDirectory | null {
  // Sync read on purpose: this feeds the cold-start first-paint seed path
  // (avatar seeding before the network answers), which runs before any
  // await boundary (Firstmate async-contract ruling, desktop task #6).
  return decode(repo.getKvSync(scopeId, KEY));
}

/** Persist the directory snapshot (whole-value overwrite — network truth wins). */
export async function writeSenderDirectory(repo: CacheRepo, scopeId: number, directory: SenderDirectory): Promise<void> {
  await repo.putKv(scopeId, KEY, {
    avatars: directory.avatars as unknown as Record<string, unknown>,
    names: directory.names as unknown as Record<string, unknown>,
  });
}
