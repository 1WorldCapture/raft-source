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
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { PRODUCT_NAME } from "./productName.js";

const execFileAsync = promisify(execFile);

export const LOGIN_AGENT_LABEL = "build.raft.desktop.login";
/** Legacy headless-service login items registered by the old carrier. */
export const LEGACY_LOGIN_LABEL_PREFIX = "build.raft.computer.login.";

/**
 * True inside an isolated test build (electron-builder.isolated.yml stamps
 * extraMetadata.name "Raft Desktop Isolated"). Probed lazily through
 * createRequire because this module is also imported by node-run unit tests
 * where the electron binding resolves to the binary path string and `app`
 * is simply absent.
 */
function isolatedTestBuild(): boolean {
  try {
    const electron = createRequire(import.meta.url)("electron") as {
      app?: { getName(): string };
    };
    const name = electron.app?.getName();
    return typeof name === "string" && name.includes("Isolated");
  } catch {
    return false;
  }
}

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
  if (enabled && isolatedTestBuild()) {
    // Guardrail (task #13 review): the login-item label is a hardcoded
    // constant shared with the owner's app — an isolated test build
    // registering it would clobber the OWNER's launch-at-login plist (and
    // point it at the test binary). Isolated builds never register.
    throw new Error("isolated test builds must not register login items");
  }
  if (enabled) {
    // File only — deliberately NOT `launchctl bootstrap`: with RunAtLoad the
    // bootstrap would immediately run our `open` and pop the window of the
    // already-running app. The plist takes effect at next login on its own.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(launchAgentsDir(), { recursive: true });
    const tmp = `${loginAgentPlistPath()}.tmp`;
    await writeFile(tmp, buildLoginAgentPlist({ appName: PRODUCT_NAME }));
    await (await import("node:fs/promises")).rename(tmp, loginAgentPlistPath());
  } else {
    // Our own job never holds a resident process (the open exits right
    // away), so bootout here cannot stop anything of ours.
    await tryRun("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LOGIN_AGENT_LABEL}`]);
    await rm(loginAgentPlistPath(), { force: true });
  }
}

/** Readback for the convergence contract: enabled = plist present. */
export async function getLoginItemAtLogin(): Promise<boolean> {
  return existsSync(loginAgentPlistPath());
}

/** Pure: extract the <string> values inside a plist's ProgramArguments. */
export function parseProgramArguments(plistXml: string): string[] {
  const args: string[] = [];
  const argsBlock = plistXml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!argsBlock) return args;
  for (const match of argsBlock[1].matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    args.push(unescapeXml(match[1].trim()));
  }
  return args;
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export interface LegacyCleanupResult {
  removed: string[];
  /** Foreign login items we deliberately left alone (standalone Computer
   * installs, other machines' homes) — logged by the caller. */
  skipped: Array<{ label: string; reason: string }>;
}

/**
 * Remove legacy headless-service login items that belong to THIS app only.
 *
 * Two safety gates, both review-mandated:
 *  1. Ownership: the plist's ProgramArguments[0] (the old carrier's
 *     dispatcher) must point inside THIS app bundle, and its `--slock-home`
 *     must match ours. A standalone `raft-computer` install owns login items
 *     under the same label prefix — deleting those would break it.
 *  2. No bootout, ever: a loaded RunAtLoad job gets SIGTERMed by bootout,
 *     which — if the running background tree was started by that job —
 *     would stop the service and every agent. Deleting the file alone is
 *     enough: launchd will not load the job at the next login.
 */
export async function cleanupLegacyLoginAgents(
  listDir: (dir: string) => Promise<string[]>,
  deps: { readFile: typeof readFile; rm: typeof rm; ownExecutablePath: string; ownSlockHome: string },
): Promise<LegacyCleanupResult> {
  const result: LegacyCleanupResult = { removed: [], skipped: [] };
  let entries: string[];
  try {
    entries = await listDir(launchAgentsDir());
  } catch {
    return result; // no LaunchAgents directory — nothing to clean
  }
  for (const entry of entries) {
    if (!entry.startsWith(LEGACY_LOGIN_LABEL_PREFIX) || !entry.endsWith(".plist")) continue;
    const file = path.join(launchAgentsDir(), entry);
    const label = entry.replace(/\.plist$/, "");
    let xml = "";
    try {
      xml = await deps.readFile(file, "utf8");
    } catch {
      result.skipped.push({ label, reason: "unreadable plist" });
      continue;
    }
    const argv = parseProgramArguments(xml);
    const dispatcher = argv[0] ?? "";
    const slockHome = argv[argv.indexOf("--slock-home") + 1] ?? "";
    if (!dispatcher.startsWith(path.dirname(deps.ownExecutablePath)) && !dispatcher.startsWith(deps.ownExecutablePath)) {
      result.skipped.push({ label, reason: `dispatcher outside this app bundle: ${dispatcher}` });
      continue;
    }
    if (slockHome !== deps.ownSlockHome) {
      result.skipped.push({ label, reason: `different slock home: ${slockHome}` });
      continue;
    }
    await deps.rm(file, { force: true });
    result.removed.push(label);
  }
  return result;
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
