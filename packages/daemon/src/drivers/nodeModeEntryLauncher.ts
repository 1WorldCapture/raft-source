import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Loud-failure launcher for JavaScript entries run through the packaged
 * Electron binary in node mode (ELECTRON_RUN_AS_NODE=1).
 *
 * Electron's node mode can exit 0 with nothing on stderr when the entry file
 * fails to load as a module (the Desktop CLI incident: an ESM `index.js` with no
 * neighbouring package.json). A helper that "succeeds" without output makes the
 * managed agent turn look like an empty answer, so the wrappers run the entry
 * through this `.mjs` file instead: a `.mjs` is always ESM and cannot hit that
 * resolution problem itself, it imports the entry dynamically, and any load
 * failure becomes a message on stderr plus exit code 1.
 *
 * argv is rewritten so the entry sees itself as `process.argv[1]`, exactly as
 * if it had been launched directly.
 */
export const NODE_MODE_ENTRY_LAUNCHER_FILE = "node-mode-entry.mjs";

export const NODE_MODE_ENTRY_LAUNCHER_SOURCE = `import path from "node:path";
import { pathToFileURL } from "node:url";

const entry = process.argv[2];
if (!entry) {
  process.stderr.write("raft: node-mode launcher needs an entry file argument\\n");
  process.exit(2);
}
const resolved = path.resolve(entry);
process.argv.splice(1, 2, resolved);
try {
  await import(pathToFileURL(resolved).href);
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write("raft: failed to load " + resolved + "\\n" + detail + "\\n");
  process.exit(1);
}
`;

/** Writes the launcher next to the wrappers and returns its path. */
export function writeNodeModeEntryLauncher(slockDir: string): string {
  const launcherPath = path.join(slockDir, NODE_MODE_ENTRY_LAUNCHER_FILE);
  writeFileSync(launcherPath, NODE_MODE_ENTRY_LAUNCHER_SOURCE, { mode: 0o644 });
  return launcherPath;
}
