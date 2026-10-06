// Raft Computer release-backend STATE (private deployment, phase 2 task #5).
//
// Which release authority upgrade checks resolve through:
//   `hands`       — production default: hands.build attested releases.
//   `legacy-cdn`  — explicit manifest-tree reader at RAFT_COMPUTER_UPGRADE_BASE_URL
//                   (or the public CDN base).
//   `server`      — the SAME manifest-tree reader, with the base derived from
//                   the connected server's origin (`${origin}/downloads/computer`).
//
// State storage: `~/.slock/computer/release-backend` (one-line text), written
// by install.sh when `RAFT_COMPUTER_INSTALL_BACKEND` is set — the installer
// env itself does not survive into the launchd/systemd service context, the
// persisted file does (exact twin of the `computer/channel` contract).
//
// Reading is intentionally lenient like channelState: absent / unreadable /
// unrecognized content returns null (no backend selected → fall through to
// the default), never throws. `raft-computer doctor` can surface a corrupt
// value without upgrade checks breaking on it.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { releaseBackendPath } from "../paths.js";

export type ReleaseBackend = "hands" | "legacy-cdn" | "server";

/** Per-process explicit backend selector (highest non-override authority). */
export const RELEASE_BACKEND_ENV = "RAFT_COMPUTER_RELEASE_BACKEND";

/**
 * Validate a backend string. Returns the canonical value (trimmed) when
 * valid; null otherwise.
 */
export function parseReleaseBackend(raw: string): ReleaseBackend | null {
  const v = raw.trim();
  return v === "hands" || v === "legacy-cdn" || v === "server" ? v : null;
}

/**
 * Read the persisted release backend from `~/.slock/computer/release-backend`.
 * Returns null when absent / unreadable / unrecognized — "no selection",
 * the caller applies its own default chain.
 */
export async function readReleaseBackend(slockHome: string): Promise<ReleaseBackend | null> {
  try {
    const raw = await readFile(releaseBackendPath(slockHome), "utf8");
    return parseReleaseBackend(raw);
  } catch {
    /* missing / unreadable → no selection */
  }
  return null;
}

/**
 * Write the release backend value. Caller MUST pass an already-validated
 * value (use `parseReleaseBackend` first). Mode 0600 matches other
 * Computer-local state.
 */
export async function writeReleaseBackend(
  slockHome: string,
  backend: ReleaseBackend,
): Promise<void> {
  const p = releaseBackendPath(slockHome);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${backend}\n`, { mode: 0o600 });
}

/**
 * Synchronous twin for surfaces that cannot await (the CLI error presenter).
 * Same leniency: absent / unreadable / unrecognized → null.
 */
export function readReleaseBackendSync(slockHome: string): ReleaseBackend | null {
  try {
    return parseReleaseBackend(readFileSync(releaseBackendPath(slockHome), "utf8"));
  } catch {
    return null;
  }
}
