import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import tsupConfig from "../../tsup.config.ts";
import { resolveBuildApiConfig } from "../../buildConfig.mjs";
import { embeddedComputerVersions } from "../../../../packages/computer/scripts/embeddedVersionDefines.mjs";

// REGRESSION pin: this desktop app inlines @botiverse/raft-computer. Without
// baked version identifiers, the inlined Computer reads this app's own
// package.json and reports the app version as the Computer version, so the
// server flags the machine as permanently upgradeable.

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = join(APP_ROOT, "dist");

async function readJson(path: string): Promise<{ version: string }> {
  return JSON.parse(await readFile(path, "utf8")) as { version: string };
}

test("main bundle bakes the Computer, daemon and CLI package versions", async () => {
  assert.ok(Array.isArray(tsupConfig), "tsup config is a static list");
  const main = tsupConfig.find((config) => config.entry && typeof config.entry === "object" && "main" in config.entry);
  assert.ok(main, "tsup config has a main entry");
  const versions = embeddedComputerVersions();
  assert.deepEqual(main.define, {
    __RAFT_COMPUTER_VERSION__: JSON.stringify(versions.computer),
    __RAFT_DAEMON_VERSION__: JSON.stringify(versions.daemon),
    __RAFT_CLI_VERSION__: JSON.stringify(versions.cli),
    __RAFT_DESKTOP_API_ORIGIN__: JSON.stringify(resolveBuildApiConfig().apiOrigin),
  });
  const computerPkg = await readJson(join(APP_ROOT, "..", "..", "packages", "computer", "package.json"));
  assert.equal(versions.computer, computerPkg.version);
});

test("built bundle leaves no version identifier unresolved (skips without a build)", async (t) => {
  let files: string[];
  try {
    files = (await readdir(DIST)).filter((name) => name.endsWith(".js"));
  } catch {
    t.skip("dist/ missing — run pnpm run build:main first");
    return;
  }
  if (files.length === 0) {
    t.skip("dist/ has no bundle");
    return;
  }
  const appPkg = await readJson(join(APP_ROOT, "package.json"));
  const versions = embeddedComputerVersions();
  let bakedComputer = false;
  for (const name of files) {
    const source = await readFile(join(DIST, name), "utf8");
    assert.doesNotMatch(source, /__RAFT_(COMPUTER|DAEMON|CLI)_VERSION__/, `${name} still references a version identifier`);
    const baked = /function readBakedComputerVersion\(\) \{\s*return [^;]*?"([^"]+)"/.exec(source);
    if (baked) {
      assert.equal(baked[1], versions.computer, `${name} bakes the wrong Computer version`);
      bakedComputer = true;
    }
  }
  assert.ok(bakedComputer, `bundle bakes Computer ${versions.computer}, not app ${appPkg.version}`);
});
