// Account skin preference (cross-device skin sync, #mobile-skin task #2).
//
// TEMPORARY id list: the shared skin module (task #1 step 1, apps + mobile) will
// own it; this file must then import it instead (skinPreference.test.ts pins
// the list to the desktop's SKINS meanwhile so the two cannot drift).
export const KNOWN_SKIN_IDS: readonly string[] = [
  "signal", "amber", "peach", "coral", "blush", "rose", "lilac", "iris", "sky", "aqua", "sage", "sand", "cloud",
];

/**
 * undefined = field not sent (leave as is), null = clear (back to "not chosen"),
 * otherwise a known skin id (lower-cased, trimmed). Throws on anything else.
 */
export function parsePreferredSkin(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("preferredSkin must be a known skin id or null");
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (!KNOWN_SKIN_IDS.includes(value)) throw new Error("preferredSkin must be a known skin id or null");
  return value;
}
