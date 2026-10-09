// Account skin preference (cross-device skin sync, #mobile-skin task #2).
// The skin id list is the shared module's (imported by file path, not the
// shared barrel) so server, desktop and mobile can never disagree.
import { isSkinId } from "@botiverse/raft-shared/src/skins.js";

/**
 * undefined = field not sent (leave as is), null = clear (back to "not chosen"),
 * otherwise a known skin id (trimmed, lower-cased). Throws on anything else.
 */
export function parsePreferredSkin(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("preferredSkin must be a known skin id or null");
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (!isSkinId(value)) throw new Error("preferredSkin must be a known skin id or null");
  return value;
}
