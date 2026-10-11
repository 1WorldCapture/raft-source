// The detached Computer children (`__service`, `__run <serverId>`) re-exec THIS Electron binary. Even without a window
// Chromium boots its browser process and its GPU/network helpers, and those create their caches (Dawn, GPUCache,
// TransportSecurity, ...) under the app's userData. A child started without `--user-data-dir` resolves that to the
// default location, i.e. the owner's REAL Desktop userData (task #29, Anna's 0.2.3 retest). Give each headless child a
// private userData under the Computer's own home instead, so nothing it does can touch the interactive app's data.
import path from "node:path";

export type HeadlessMode = "__service" | "__run";

/** `<raftHome>/computer/electron-userdata/<service|run-<serverId>>`, or null for a normal (GUI) launch. */
export function headlessUserDataDir(raftHome: string, headless: { mode: HeadlessMode; rest: string[] } | null): string | null {
  if (!headless) return null;
  const root = path.join(raftHome, "computer", "electron-userdata");
  if (headless.mode === "__service") return path.join(root, "service");
  const serverId = headless.rest[0];
  // Server ids are uuids; keep the directory name to one safe path segment whatever arrives on the command line.
  const segment = serverId && /^[A-Za-z0-9._-]{1,128}$/.test(serverId) && serverId !== "." && serverId !== ".." ? serverId : "unknown";
  return path.join(root, `run-${segment}`);
}
