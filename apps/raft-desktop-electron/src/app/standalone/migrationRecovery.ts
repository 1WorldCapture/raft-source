// A migration that succeeded but whose app-side finish never ran (the app quit, crashed or was killed between the
// Computer's `migrate-home` finishing and us writing computer-host.json). Without this, the next launch would see no
// standalone marker, take the embedded path and converge a built-in host at the OLD home: a second Computer.
//
// There is no 'switch back to built-in' feature, so the age of the result does not matter: a built-in host that
// converged after a long gap would take over ~/.slock-raft, which already points at the NEW home. Detection: no standalone marker, and a migrate-result.json (in the embedded home or the standard home) records a
// success whose from/to is this app's embedded home. Completion is the same finish the dialog
// does after a success (copy the Cursor SDK, write the marker); the app then continues straight into standalone mode.
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ComputerHostMode } from "./hostMode.js";

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
  const mine = await canonical(input.embeddedHome);
  for (const home of [...new Set([input.embeddedHome, ...input.otherHomes])]) {
    const result = await read(home);
    if (!result || result.result !== "success" || !result.to) continue;
    const candidates = await Promise.all([result.from, result.to].filter((p): p is string => p !== null).map((p) => canonical(p)));
    if (!candidates.includes(mine) && !candidates.includes(path.resolve(input.embeddedHome))) continue;
    if (!(await isDirectory(result.to))) continue;
    return { to: result.to };
  }
  return null;
}

// --- a migration still running when the app starts ---------------------------------------------------------------

export interface InProgressMarker {
  pid: number;
  from: string | null;
  to: string | null;
  startedAt: string | null;
  /** When the Computer's own hard time limit rolls the move back, and the step it is on (updated every step). */
  deadlineAt?: string | null;
  step?: string | null;
  /** Where the marker was found. */
  home: string;
}

/** `<home>/computer/migrate-in-progress.json` written by `migrate-home --apply` at its start, removed when it finishes. */
export async function readInProgressMarker(home: string): Promise<InProgressMarker | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(home, "computer", "migrate-in-progress.json"), "utf8")) as Record<string, unknown>;
    return typeof raw.pid === "number" && raw.pid > 0 ? { pid: raw.pid, from: str(raw.from), to: str(raw.to), startedAt: str(raw.startedAt), deadlineAt: str(raw.deadlineAt), step: str(raw.step), home } : null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
}

/**
 * If a `migrate-home` started before this launch is still running (the app died mid-move and the command carries on
 * by itself), wait for it to end so nothing converges a built-in host under it. Returns true when one was waited for.
 */
export async function waitForRunningMigration(input: {
  hostMode: ComputerHostMode;
  homes: string[];
  readMarker?: (home: string) => Promise<InProgressMarker | null>;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  onWaiting?: (marker: InProgressMarker) => void;
}): Promise<boolean> {
  if (input.hostMode.mode === "standalone") return false;
  const read = input.readMarker ?? readInProgressMarker;
  const alive = input.isAlive ?? processAlive;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (input.timeoutMs ?? 10 * 60_000);
  let waited = false;
  for (;;) {
    let live: InProgressMarker | null = null;
    for (const home of [...new Set(input.homes)]) {
      const marker = await read(home);
      if (marker && alive(marker.pid)) { live = marker; break; }
    }
    if (!live) return waited;
    if (!waited) input.onWaiting?.(live);
    waited = true;
    if (Date.now() > deadline) return waited;
    await sleep(1000);
  }
}

/**
 * The built-in home is gone but the standard home holds a Computer that a migration put there (a result file, a
 * running marker or a live service socket): the Computer was moved away. Return that home so the app adopts it
 * instead of rebuilding an empty built-in home and offering "Enable".
 */
export async function findMigratedAwayHome(input: {
  hostMode: ComputerHostMode;
  embeddedHome: string;
  standardHome: string;
  exists?: (p: string) => Promise<boolean>;
}): Promise<string | null> {
  if (input.hostMode.mode === "standalone") return null;
  const exists = input.exists ?? (async (p: string) => { try { await stat(p); return true; } catch { return false; } });
  if (path.resolve(input.embeddedHome) === path.resolve(input.standardHome)) return null;
  if (await exists(input.embeddedHome)) return null;
  for (const marker of ["migrate-result.json", "migrate-in-progress.json", path.join("run", "service.sock")]) {
    if (await exists(path.join(input.standardHome, "computer", marker))) return input.standardHome;
  }
  return null;
}

/** A migration command that is running right now (marker with a live pid), without waiting for it. */
export async function findRunningMigration(input: {
  hostMode: ComputerHostMode;
  homes: string[];
  readMarker?: (home: string) => Promise<InProgressMarker | null>;
  isAlive?: (pid: number) => boolean;
}): Promise<InProgressMarker | null> {
  if (input.hostMode.mode === "standalone") return null;
  const read = input.readMarker ?? readInProgressMarker;
  const alive = input.isAlive ?? processAlive;
  for (const home of [...new Set(input.homes)]) {
    const marker = await read(home);
    if (marker && alive(marker.pid)) return marker;
  }
  return null;
}
