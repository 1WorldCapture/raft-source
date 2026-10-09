// Which Computer this desktop controls (#computer-extract task #1).
//
// `computer-host.json` (in the app's userData) records the choice:
//   - absent / "embedded": the existing behavior — this app hosts its own
//     Computer (ComputerHost). Nothing changes until the user switches or migrates.
//   - "standalone": one independent `raft-computer` per machine (home `~/.slock`)
//     is the Computer; this app is only a UI for it (no converge, no watchdog,
//     no login-item takeover, quitting the app never stops agents).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type ComputerHostMode = { mode: "embedded" } | { mode: "standalone"; home: string };

export const COMPUTER_HOST_FILE = "computer-host.json";

/** Default home of the single standalone Computer: `~/.slock` (RAFT_HOME / SLOCK_HOME override it, as everywhere else). */
export function defaultStandaloneHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const override = env.RAFT_HOME?.trim() || env.SLOCK_HOME?.trim();
  return override ? path.resolve(override) : path.join(home, ".slock");
}

/** Where the app copies the Computer binary: `~/.local/bin/raft-computer` (the CLI installer's location). */
export function defaultBinaryPath(home: string = homedir()): string {
  return path.join(home, ".local", "bin", process.platform === "win32" ? "raft-computer.exe" : "raft-computer");
}

export function parseHostMode(raw: unknown): ComputerHostMode {
  if (typeof raw !== "object" || raw === null) return { mode: "embedded" };
  const record = raw as Record<string, unknown>;
  if (record.mode === "standalone" && typeof record.home === "string" && path.isAbsolute(record.home)) {
    return { mode: "standalone", home: path.normalize(record.home) };
  }
  return { mode: "embedded" };
}

/** A missing, unreadable or malformed file means "embedded" (never throws): the default must stay today's behavior. */
export async function readHostMode(userDataDir: string): Promise<ComputerHostMode> {
  try {
    return parseHostMode(JSON.parse(await readFile(path.join(userDataDir, COMPUTER_HOST_FILE), "utf8")));
  } catch {
    return { mode: "embedded" };
  }
}

export async function writeHostMode(userDataDir: string, mode: ComputerHostMode): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  const target = path.join(userDataDir, COMPUTER_HOST_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(mode, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}
