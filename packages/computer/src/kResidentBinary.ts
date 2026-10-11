import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { executableFileIdentity } from "@botiverse/raft-shared";

import { kSlotBinaryPath } from "./kPaths.js";
import {
  compareRealFiles,
  type RealFileIdentity,
  type ResolveRealPath,
} from "./realFileIdentity.js";

export type KBinaryAccess = (filePath: string) => Promise<void>;

// Captured at module load, i.e. before any later K promotion or staging can
// rename or replace the file behind process.execPath (upstream liveExecutable
// semantics): identity, not path spelling, decides which file IS the running
// binary once K renames slots underneath it.
const STARTUP_BINARY_IDENTITY = executableFileIdentity(process.execPath);

/** Identity seams; tests inject fakes, production uses dev:ino statistics. */
export interface KResidentBinaryIdentity {
  /** Identity of the file this process was started from (null = platform has none). */
  startupIdentity(): string | null;
  /** Identity of a path's CURRENT file, or null when it does not exist. */
  identityOf(path: string): string | null;
}

async function exists(filePath: string, accessFn: KBinaryAccess): Promise<boolean> {
  try {
    await accessFn(filePath);
    return true;
  } catch {
    return false;
  }
}

function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
  resolveRealPath: ResolveRealPath,
): RealFileIdentity {
  return compareRealFiles(left, right, resolveRealPath, platform === "win32");
}

/**
 * Resolve the SEA bytes that own the next resident/coordinator process.
 *
 * The first K-capable carrier remains installed as a dispatcher. Once K has a
 * stable slot, every cold spawn must use that slot instead of the dispatcher's
 * old embedded core. A live experiment keeps using itself until promotion;
 * promotion renames its path away, after which the same process resolves the
 * new stable path for later runner/coordinator spawns.
 */
export async function resolveKResidentBinary(
  slockHome: string,
  currentBinary = process.execPath,
  isSea = false,
  accessFn: KBinaryAccess = access,
  platform: NodeJS.Platform = process.platform,
  resolveRealPath: ResolveRealPath = realpathSync.native,
  identity: KResidentBinaryIdentity = {
    startupIdentity: () => STARTUP_BINARY_IDENTITY,
    identityOf: executableFileIdentity,
  },
): Promise<string> {
  if (!isSea) return currentBinary;
  const current = resolve(currentBinary);
  const experiment = resolve(kSlotBinaryPath(slockHome, "experiment"));
  const stable = resolve(kSlotBinaryPath(slockHome, "stable"));
  const equalSpelling = (left: string, right: string): boolean => platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;

  // Identity guard (upstream liveExecutable semantics): a K promotion renames
  // the running experiment slot to stable, and K may later re-stage the NEXT
  // candidate into the experiment path. Spelling alone then mistakes the new
  // candidate for the running binary. When the startup identity is available,
  // the file whose CURRENT identity equals it is the running binary — if that
  // is stable, later spawns must use stable even though the startup path
  // exists again with different bytes. Platforms without a usable identity
  // (and tests that inject none) keep the spelling-based behavior below.
  const startupIdentity = identity.startupIdentity();
  if (startupIdentity !== null && identity.identityOf(current) !== startupIdentity) {
    if (identity.identityOf(stable) === startupIdentity) return stable;
  }

  // Windows paths are case-insensitive. Returning currentBinary here is
  // deliberate: a differently-cased spelling of the same running slot must
  // not look like a second resident and recurse through the dispatcher.
  const experimentExists = await exists(experiment, accessFn);
  if (experimentExists) {
    const experimentIdentity = samePath(current, experiment, platform, resolveRealPath);
    if (experimentIdentity !== "different") return currentBinary;
  }
  if (await exists(stable, accessFn)) {
    // The running experiment's path is renamed to stable during promotion.
    // Exact slot spelling is sufficient to follow that deliberate rename;
    // real-file lookup of the now-absent old pathname cannot succeed.
    if (!experimentExists && equalSpelling(current, experiment)) return stable;
    const stableIdentity = samePath(current, stable, platform, resolveRealPath);
    if (stableIdentity !== "different") return currentBinary;
    return stable;
  }
  // A dispatcher must never boot an unpromoted experiment merely because
  // stable is absent. Only an already-running experiment may keep using its
  // own exact path; every other partial world fails closed to current bytes.
  return currentBinary;
}
