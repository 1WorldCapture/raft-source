import { existsSync, statSync } from "node:fs";
import { resolveLiveExecutablePath } from "@botiverse/raft-shared";

/**
 * `dev:ino` of a file, or null when the platform cannot report one. Lives
 * here (node side) rather than in shared: shared is consumed as source by
 * the browser web package and must stay free of node:fs imports (same shape
 * as the daemon's drivers/cliTransport copy — upstream keeps one per package).
 */
export function executableFileIdentity(path: string, statOf: (p: string) => { dev: number; ino: number } = statSync): string | null {
  try {
    const stat = statOf(path);
    return stat.ino > 0 ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

// Captured at module load, i.e. before any later K promotion or staging can
// rename or replace the file behind process.execPath.
const STARTUP_EXECUTABLE_IDENTITY = executableFileIdentity(process.execPath);

/**
 * The running Computer binary's re-execable path. A K upgrade promotes the
 * experiment slot to stable by renaming it under the running process, so the
 * startup `process.execPath` can name a path that no longer exists; see
 * resolveLiveExecutablePath in shared. Callers that re-exec, spawn children
 * as this binary, or read its version/channel must use this instead of
 * process.execPath whenever the call can happen after a promotion.
 */
export function liveProcessExecutablePath(): string {
  return resolveLiveExecutablePath({
    execPath: process.execPath,
    platform: process.platform,
    exists: existsSync,
    identityOf: executableFileIdentity,
    startupIdentity: STARTUP_EXECUTABLE_IDENTITY,
  });
}
