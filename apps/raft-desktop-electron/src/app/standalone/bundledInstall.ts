// Copies the Computer files that ship inside the desktop app to where the
// standalone Computer expects them, so the app never points a service at a path
// inside its own bundle (that path changes on every app update).
//   binary      -> ~/.local/bin/raft-computer           (same place the CLI installer uses)
//   cursor-sdk  -> <home>/runtime/cursor-sdk/            (daemon discovery: RAFT_CURSOR_SDK_ASSETS, then this)
// Only copies when the bundled version is NEWER (or the target is missing/unreadable). Replacement is
// atomic (write a temp sibling, then rename), so a running Computer is never left with a half-written file.
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Strict triple + optional suffix ("1.0.29", "0.0.24-zcode.1"). Returns null when it is not a version. */
export function parseVersion(text: string | null | undefined): { core: [number, number, number]; pre: string } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec((text ?? "").trim());
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" } : null;
}

/** >0 when a is newer than b. A release outranks a pre-release of the same core; unparsable versions compare as "older". */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x) return y ? -1 : 0;
  if (!y) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface BundledComputer {
  /** `<resources>/computer/raft-computer` and its version (from the app's bundled version file). */
  binaryPath: string | null;
  binaryVersion: string | null;
  /** `<resources>/cursor-sdk` (manifest.json inside). */
  cursorRoot: string | null;
}

export interface InstallInput {
  bundled: BundledComputer;
  /** Target of the binary, e.g. ~/.local/bin/raft-computer. */
  binaryTarget: string;
  /** Standalone home (~/.slock). */
  home: string;
  /** Version of the Computer already on the machine (`raft-computer --version`), null when none. */
  installedBinaryVersion: string | null;
  /** SDK version of the cursor-sdk tree already under <home>/runtime, null when none. */
  platform?: NodeJS.Platform;
  removeQuarantine?: (target: string) => Promise<void>;
}

export interface InstallResult {
  binary: "installed" | "upgraded" | "current" | "unavailable";
  cursorSdk: "installed" | "upgraded" | "current" | "unavailable";
  binaryPath: string;
  cursorSdkPath: string;
}

export const CURSOR_RUNTIME_SUBPATH = path.join("runtime", "cursor-sdk");

async function manifestSdkVersion(root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { sdkVersion?: unknown };
    return typeof manifest.sdkVersion === "string" ? manifest.sdkVersion : null;
  } catch {
    return null;
  }
}

const exists = (target: string) => stat(target).then(() => true, () => false);

/** macOS marks files copied from a downloaded app as quarantined; Gatekeeper would then block the copy. */
export const stripQuarantine = (target: string): Promise<void> =>
  new Promise((resolve) => {
    execFile("xattr", ["-dr", "com.apple.quarantine", target], () => resolve()); // absent attribute = nonzero exit; fine
  });

export async function installBundledComputer(input: InstallInput): Promise<InstallResult> {
  const platform = input.platform ?? process.platform;
  const cursorTarget = path.join(input.home, CURSOR_RUNTIME_SUBPATH);
  const result: InstallResult = { binary: "unavailable", cursorSdk: "unavailable", binaryPath: input.binaryTarget, cursorSdkPath: cursorTarget };
  const strip = input.removeQuarantine ?? stripQuarantine;

  if (input.bundled.binaryPath && (await exists(input.bundled.binaryPath))) {
    const present = await exists(input.binaryTarget);
    if (present && compareVersions(input.bundled.binaryVersion, input.installedBinaryVersion) <= 0) {
      result.binary = "current";
    } else {
      await mkdir(path.dirname(input.binaryTarget), { recursive: true });
      const temp = `${input.binaryTarget}.tmp-${process.pid}`;
      await rm(temp, { force: true });
      await cp(input.bundled.binaryPath, temp);
      await chmod(temp, 0o755);
      if (platform === "darwin") await strip(temp);
      await rename(temp, input.binaryTarget);
      result.binary = present ? "upgraded" : "installed";
    }
  }

  if (input.bundled.cursorRoot && (await exists(path.join(input.bundled.cursorRoot, "manifest.json")))) {
    const bundledVersion = await manifestSdkVersion(input.bundled.cursorRoot);
    const installedVersion = (await exists(cursorTarget)) ? await manifestSdkVersion(cursorTarget) : null;
    if (installedVersion && compareVersions(bundledVersion, installedVersion) <= 0) {
      result.cursorSdk = "current";
    } else {
      await mkdir(path.dirname(cursorTarget), { recursive: true });
      const temp = `${cursorTarget}.tmp-${process.pid}`;
      const old = `${cursorTarget}.old-${process.pid}`;
      await rm(temp, { recursive: true, force: true });
      await cp(input.bundled.cursorRoot, temp, { recursive: true });
      if (platform === "darwin") await strip(temp);
      const hadOld = await exists(cursorTarget);
      if (hadOld) await rename(cursorTarget, old);
      try {
        await rename(temp, cursorTarget);
      } catch (error) {
        if (hadOld) await rename(old, cursorTarget).catch(() => undefined); // put the previous tree back
        throw error;
      }
      if (hadOld) await rm(old, { recursive: true, force: true });
      result.cursorSdk = hadOld ? "upgraded" : "installed";
    }
  }
  return result;
}
