import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Persistent user intent for the Computer service ("desiredState").
 *
 * Written by the `start` / `stop` CLI commands; read by the login item at
 * launch (RunAtLoad) so a user-stopped Computer STAYS stopped across reboots
 * (#computer-extract PM decision 2026-10-09: "Stop is persistent — until the
 * user presses Start again"), and surfaced via `status --json` so clients can
 * distinguish "stopped (by the user)" from "not running (crashed)".
 *
 * On-disk shape follows the package's typed-JSON state-file conventions
 * (paths.ts): schemaVersion stamped on write, missing file tolerated on read
 * (treated as "running" — the pre-extract behaviour where the login item
 * always started the service).
 */

export type DesiredServiceState = "running" | "stopped";

export interface DesiredServiceStateFile {
  schemaVersion: number;
  state: DesiredServiceState;
  /** When the intent last changed (ISO-8601). Debug surface only. */
  updatedAt: string;
}

const SCHEMA_VERSION = 1;

export function desiredStatePath(slockHome: string): string {
  return path.join(slockHome, "computer", "desired-state.json");
}

/** Absence is "running": never let a missing file keep a wanted service down. */
export function parseDesiredState(raw: unknown): DesiredServiceState {
  if (typeof raw === "object" && raw !== null && "state" in raw) {
    const value = (raw as { state?: unknown }).state;
    if (value === "stopped") return "stopped";
  }
  return "running";
}

export async function readDesiredState(slockHome: string): Promise<DesiredServiceState> {
  try {
    const raw = await fs.readFile(desiredStatePath(slockHome), "utf8");
    return parseDesiredState(JSON.parse(raw));
  } catch {
    return "running";
  }
}

export async function writeDesiredState(slockHome: string, state: DesiredServiceState): Promise<void> {
  const file = desiredStatePath(slockHome);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload: DesiredServiceStateFile = {
    schemaVersion: SCHEMA_VERSION,
    state,
    updatedAt: new Date().toISOString(),
  };
  // Atomic-ish: write-then-rename so a crash mid-write never corrupts intent.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}
