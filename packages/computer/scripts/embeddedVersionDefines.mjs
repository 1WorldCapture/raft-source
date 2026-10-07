import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Build-time version identity for bundles that INLINE @botiverse/raft-computer
// (the Electron desktop app and the menu-bar app). `src/version.ts` prefers
// these baked identifiers; without them it falls back to the nearest
// `../package.json` of the running bundle — which, once inlined into an app's
// `dist/main.js`, is the APP's package.json. The Computer would then report the
// app version (e.g. 0.1.8) instead of its own, and the server would flag it as
// permanently upgradeable. Same sources as `scripts/native/build.mjs`.

const COMPUTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageVersion(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`missing version in ${root}/package.json`);
  }
  return pkg.version;
}

export function embeddedComputerVersions() {
  return {
    computer: packageVersion(COMPUTER_ROOT),
    daemon: packageVersion(resolve(COMPUTER_ROOT, "..", "daemon")),
    cli: packageVersion(resolve(COMPUTER_ROOT, "..", "cli")),
  };
}

/** esbuild/tsup `define` map for bundles that inline raft-computer. */
export function embeddedComputerVersionDefines() {
  const versions = embeddedComputerVersions();
  return {
    __RAFT_COMPUTER_VERSION__: JSON.stringify(versions.computer),
    __RAFT_DAEMON_VERSION__: JSON.stringify(versions.daemon),
    __RAFT_CLI_VERSION__: JSON.stringify(versions.cli),
  };
}
