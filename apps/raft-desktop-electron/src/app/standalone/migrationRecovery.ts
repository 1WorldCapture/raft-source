// A migration that succeeded but whose app-side finish never ran (the app quit, crashed or was killed between the
// Computer's `migrate-home` finishing and us writing computer-host.json). Without this, the next launch would see no
// standalone marker, take the embedded path and converge a built-in host at the OLD home: a second Computer.
//
// Detection: no standalone marker, and a migrate-result.json (in the embedded home or the standard home) records a
// success within the last day whose from/to is this app's embedded home. Completion is the same finish the dialog
// does after a success (copy the Cursor SDK, write the marker); the app then continues straight into standalone mode.
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ComputerHostMode } from "./hostMode.js";

export const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MigrationResultSummary {
  result: string;
  from: string | null;
  to: string | null;
  finishedAt: string | null;
}

export interface RecoveryInput {
  hostMode: ComputerHostMode;
  /** Home the built-in host would use (RAFT_HOME / SLOCK_HOME / ~/.slock). */
  embeddedHome: string;
  /** Other places a result file may live (the standard standalone home). */
  otherHomes: string[];
  now?: () => number;
  readResult?: (home: string) => Promise<MigrationResultSummary | null>;
  canonical?: (p: string) => Promise<string>;
  isDirectory?: (p: string) => Promise<boolean>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function readMigrationResult(home: string): Promise<MigrationResultSummary | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(home, "computer", "migrate-result.json"), "utf8")) as Record<string, unknown>;
    return { result: String(raw.result), from: str(raw.from), to: str(raw.to), finishedAt: str(raw.finishedAt) };
  } catch {
    return null;
  }
}

const defaultCanonical = async (p: string) => { try { return await realpath(p); } catch { return path.resolve(p); } };
const defaultIsDirectory = async (p: string) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

/** The new home to finish switching to, or null when nothing was interrupted. */
export async function findInterruptedMigration(input: RecoveryInput): Promise<{ to: string } | null> {
  if (input.hostMode.mode === "standalone") return null;
  const read = input.readResult ?? readMigrationResult;
  const canonical = input.canonical ?? defaultCanonical;
  const isDirectory = input.isDirectory ?? defaultIsDirectory;
  const now = (input.now ?? Date.now)();
  const mine = await canonical(input.embeddedHome);
  for (const home of [...new Set([input.embeddedHome, ...input.otherHomes])]) {
    const result = await read(home);
    if (!result || result.result !== "success" || !result.to) continue;
    const finished = result.finishedAt ? Date.parse(result.finishedAt) : NaN;
    if (!Number.isFinite(finished) || now - finished > RECOVERY_WINDOW_MS || finished > now + 60_000) continue;
    const candidates = await Promise.all([result.from, result.to].filter((p): p is string => p !== null).map((p) => canonical(p)));
    if (!candidates.includes(mine) && !candidates.includes(path.resolve(input.embeddedHome))) continue;
    if (!(await isDirectory(result.to))) continue;
    return { to: result.to };
  }
  return null;
}
