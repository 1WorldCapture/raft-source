// A Unix socket path is limited to 103 characters (AF_UNIX sun_path: 104 on macOS, 108 on Linux, minus the NUL).
// The service binds `<home>/computer/run/service.sock`. A selected deployment home under
// `~/Library/Application Support/<app>/computer-deployments/<name>` is far too long for that, which is why the
// Computer has always been reached through the short `~/.slock-raft` alias on machines like the owner's. Pinning the
// process to the long real path (#298) would make the service fail to bind (EINVAL) and every agent go offline.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MAX_SOCKET_PATH_BYTES = 103;
export const ALIAS_NAME = ".slock-raft";

export const serviceSocketFor = (home: string): string => path.join(home, "computer", "run", "service.sock");
export const socketBytes = (home: string): number => Buffer.byteLength(serviceSocketFor(home));

export type SocketSafeHome = { home: string; usedAlias: boolean; error?: undefined } | { error: string; home: string; usedAlias: false };

export function chooseSocketSafeHome(
  home: string,
  deps: { aliasPath?: string; realpath?: (p: string) => string; limit?: number } = {},
): SocketSafeHome {
  const limit = deps.limit ?? MAX_SOCKET_PATH_BYTES;
  if (Buffer.byteLength(serviceSocketFor(home)) <= limit) return { home, usedAlias: false };
  const real = deps.realpath ?? ((p: string) => realpathSync(p));
  const alias = deps.aliasPath ?? path.join(homedir(), ALIAS_NAME);
  try {
    if (real(alias) === real(home) && Buffer.byteLength(serviceSocketFor(alias)) <= limit) return { home: alias, usedAlias: true };
  } catch { /* no such alias */ }
  return {
    home,
    usedAlias: false,
    error: `The Computer's folder is too deep for its socket (${socketBytes(home)} bytes, the limit is ${limit}): ${home}. Point ~/${ALIAS_NAME} at it (or move the folder somewhere shorter) and restart the app.`,
  };
}
