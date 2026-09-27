// Launch-at-login for macOS (task #7 finishing slice): a LaunchAgent that
// runs `open -a "Raft Desktop" --args --hidden` at login. The OS-native
// `app.setLoginItemSettings` route is deliberately NOT used for the hidden
// start: its `args` option is Windows-only, and `wasOpenedAtLogin` cannot be
// verified without actually logging in — while the LaunchAgent chain
// (plist → launchd → open → argv `--hidden`) is verifiable end to end on a
// live machine without disturbing any running agent. The plist also carries
// the legacy `build.raft.computer.login.*` cleanup: trees from before this
// change may still own the old headless-service login item.
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PRODUCT_NAME } from "./productName.js";

const execFileAsync = promisify(execFile);

export const LOGIN_AGENT_LABEL = "build.raft.desktop.login";
/** Legacy headless-service login items registered by the old carrier. */
export const LEGACY_LOGIN_LABEL_PREFIX = "build.raft.computer.login.";

function launchAgentsDir(): string {
  return path.join(homedir(), "Library", "LaunchAgents");
}

export function loginAgentPlistPath(): string {
  return path.join(launchAgentsDir(), `${LOGIN_AGENT_LABEL}.plist`);
}

/**
 * Pure: the LaunchAgent plist body. `open` (not the bare executable) so the
 * GUI comes up exactly like a Dock launch; `--args --hidden` so the app can
 * tell a login start from a user start in its own argv.
 */
export function buildLoginAgentPlist(input: { appName: string }): string {
  const argv = ["open", "-a", input.appName, "--args", "--hidden"]
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(LOGIN_AGENT_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${argv}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>Disabled</key>
    <false/>
  </dict>
</plist>
`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pure: is this process start a login start? (launchd ran our `open …
 * --args --hidden`; the flag lands in argv like any user-started `open -n`.) */
export function isHiddenLaunch(argv: ReadonlyArray<string>): boolean {
  return argv.includes("--hidden");
}

/**
 * Enable/disable login start. Disabling also kicks the agent out of the
 * current session (bootout) so the change is immediate, not next-login.
 */
export async function setLoginItemAtLogin(enabled: boolean): Promise<void> {
  if (enabled) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(launchAgentsDir(), { recursive: true });
    const tmp = `${loginAgentPlistPath()}.tmp`;
    await writeFile(tmp, buildLoginAgentPlist({ appName: PRODUCT_NAME }));
    await (await import("node:fs/promises")).rename(tmp, loginAgentPlistPath());
    // bootstrap loads the agent now; a failed bootstrap (e.g. already loaded)
    // is fine — the file is what counts at next login.
    await tryRun("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, loginAgentPlistPath()]);
    await tryRun("launchctl", ["enable", `gui/${process.getuid?.() ?? 0}/${LOGIN_AGENT_LABEL}`]);
  } else {
    await tryRun("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LOGIN_AGENT_LABEL}`]);
    await rm(loginAgentPlistPath(), { force: true });
  }
}

/** Readback for the convergence contract: enabled = plist present. */
export async function getLoginItemAtLogin(): Promise<boolean> {
  return existsSync(loginAgentPlistPath());
}

/**
 * Remove legacy headless-service login items (label prefix from the old
 * macosLoginCarrier). Idempotent: missing files or already-booted-out labels
 * are success. Never touches running processes.
 */
export async function cleanupLegacyLoginAgents(listDir: (dir: string) => Promise<string[]>): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await listDir(launchAgentsDir());
  } catch {
    return removed; // no LaunchAgents directory — nothing to clean
  }
  for (const entry of entries) {
    if (!entry.startsWith(LEGACY_LOGIN_LABEL_PREFIX) || !entry.endsWith(".plist")) continue;
    const file = path.join(launchAgentsDir(), entry);
    const label = entry.replace(/\.plist$/, "");
    await tryRun("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${label}`]);
    await rm(file, { force: true });
    removed.push(label);
  }
  return removed;
}

async function tryRun(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args);
  } catch {
    // bootout of an unloaded label, bootstrap of a loaded one, missing
    // launchctl — all benign for a next-login-only setting.
  }
}

/** Verify-once helper used by tests: read the plist back as text. */
export async function readLoginAgentPlist(fs: { readFile: typeof readFile }): Promise<string | null> {
  try {
    return await fs.readFile(loginAgentPlistPath(), "utf8");
  } catch {
    return null;
  }
}
