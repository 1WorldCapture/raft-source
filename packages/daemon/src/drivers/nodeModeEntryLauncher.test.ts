import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { NODE_MODE_ENTRY_LAUNCHER_FILE, writeNodeModeEntryLauncher } from "./nodeModeEntryLauncher.js";
import { writeOpencliWrapper } from "./cliTransport.js";

function run(launcher: string, args: string[]) {
  return spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8", timeout: 20_000 });
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "node-mode-launcher-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("launcher runs an entry as if launched directly: argv[1] is the entry, args and exit code pass through", () => {
  withTmp((dir) => {
    const launcher = writeNodeModeEntryLauncher(dir);
    const entry = path.join(dir, "entry.mjs");
    writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(1)));\nprocess.exitCode = 7;\n");
    const result = run(launcher, [entry, "a", "--b"]);
    assert.equal(result.status, 7);
    assert.deepEqual(JSON.parse(result.stdout), [entry, "a", "--b"]);
  });
});

test("a load failure is a non-zero exit with the reason on stderr, never a silent 0", () => {
  withTmp((dir) => {
    const launcher = writeNodeModeEntryLauncher(dir);
    const missingImport = path.join(dir, "missing-import.mjs");
    writeFileSync(missingImport, 'import "./does-not-exist.mjs";\n');
    const syntaxBroken = path.join(dir, "broken.mjs");
    writeFileSync(syntaxBroken, "export const = ;\n");
    const throwsAtLoad = path.join(dir, "throws.mjs");
    writeFileSync(throwsAtLoad, 'throw new Error("boom at load");\n');
    for (const entry of [missingImport, syntaxBroken, throwsAtLoad, path.join(dir, "no-such-file.mjs")]) {
      const result = run(launcher, [entry]);
      assert.equal(result.status, 1, `${path.basename(entry)}: ${result.stderr}`);
      assert.match(result.stderr, /raft: failed to load /);
    }
    assert.match(run(launcher, [throwsAtLoad]).stderr, /boom at load/);
  });
});

test("without an entry argument the launcher says so and exits 2", () => {
  withTmp((dir) => {
    const result = run(writeNodeModeEntryLauncher(dir), []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs an entry file/);
  });
});

test("Electron-host wrappers route the entry through the launcher; plain-node wrappers are unchanged", async () => {
  await withTmp(async (dir) => {
    const bin = path.join(dir, "opencli-main.js");
    writeFileSync(bin, "// opencli\n");
    const electronDir = path.join(dir, "electron");
    const plainDir = path.join(dir, "plain");
    const winDir = path.join(dir, "win");
    for (const d of [electronDir, plainDir, winDir]) mkdirSync(d, { recursive: true });
    writeOpencliWrapper(electronDir, bin, "linux", true);
    writeOpencliWrapper(plainDir, bin, "linux", false);
    writeOpencliWrapper(winDir, bin, "win32", true);
    const launcher = path.join(electronDir, NODE_MODE_ENTRY_LAUNCHER_FILE);
    assert.ok(existsSync(launcher));
    assert.match(readFileSync(path.join(electronDir, "opencli"), "utf8"), new RegExp(`exec \\S+ '${launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' "\\$OPENCLI_BIN" "\\$@"`));
    assert.doesNotMatch(readFileSync(path.join(plainDir, "opencli"), "utf8"), /node-mode-entry/);
    assert.ok(!existsSync(path.join(plainDir, NODE_MODE_ENTRY_LAUNCHER_FILE)));
    assert.match(readFileSync(path.join(winDir, "opencli.cmd"), "utf8"), /node-mode-entry\.mjs" "%OPENCLI_BIN%" %\*/);
  });
});

test("every entry run in Electron node mode resolves as ESM (audit)", () => {
  const require = createRequire(import.meta.url);
  const moduleFormat = (entry: string): string => {
    if (entry.endsWith(".mjs")) return "esm";
    if (entry.endsWith(".cjs")) return "cjs";
    let dir = path.dirname(entry);
    for (;;) {
      const manifest = path.join(dir, "package.json");
      if (existsSync(manifest)) return (JSON.parse(readFileSync(manifest, "utf8")) as { type?: string }).type === "module" ? "esm" : "cjs";
      const parent = path.dirname(dir);
      if (parent === dir) return "cjs";
      dir = parent;
    }
  };
  // opencli: `bin` of the daemon's @jackwener/opencli dependency.
  const opencliMain = require.resolve("@jackwener/opencli");
  assert.equal(moduleFormat(opencliMain), "esm", `opencli entry ${opencliMain} must resolve as ESM via its package.json`);
  // The raft CLI: `bin` of packages/cli (packaged into Desktop with its own package.json, see bundledCliPackaging.test).
  const cliManifest = path.resolve(import.meta.dirname, "../../../cli/package.json");
  assert.equal((JSON.parse(readFileSync(cliManifest, "utf8")) as { type?: string }).type, "module");
});
