import { existsSync } from "node:fs";
import { executableFileIdentity, resolveLiveExecutablePath } from "@botiverse/raft-shared";

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
