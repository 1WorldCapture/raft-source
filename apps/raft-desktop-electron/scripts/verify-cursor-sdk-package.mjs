#!/usr/bin/env node
/** Read-only verification of the actual local E2E .app, not just its staging tree. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(appRoot, "package.json"));
// Reuse electron-builder's exact installed archive reader (no network/npx).
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const asar = libRequire("@electron/asar");
const appPath = path.resolve(process.argv[2] ?? path.join(appRoot, "release-cursor-sdk/mac-arm64/Raft Desktop.app"));
const resources = path.join(appPath, "Contents/Resources");
const assetRoot = realpathSync(path.join(resources, "cursor-sdk"));
const manifest = JSON.parse(readFileSync(path.join(assetRoot, "manifest.json"), "utf8"));
const hash = (data) => createHash("sha256").update(data).digest("hex");

function confined(relative) {
  assert.equal(typeof relative, "string");
  assert.ok(relative && !path.isAbsolute(relative) && !relative.includes("\\") && !relative.split("/").some((v) => v === ".." || v === "." || v === ""), "Unconfined manifest path");
  const file = path.join(assetRoot, relative);
  const s = lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink(), `Invalid asset type: ${relative}`);
  const real = realpathSync(file);
  assert.ok(real.startsWith(`${assetRoot}${path.sep}`), "Asset escaped resource root");
  return file;
}
function walk(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${prefix}${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `Unexpected asset symlink: ${rel}`);
    return entry.isDirectory() ? walk(path.join(dir, entry.name), `${rel}/`) : [rel];
  });
}

assert.equal(manifest.sdkVersion, "1.0.36");
assert.equal(manifest.nodeVersion, "24.15.0");
assert.equal(manifest.target, "darwin-arm64");
assert.ok(manifest.files && Object.keys(manifest.files).length > 100, "Asset inventory is missing");
for (const relative of ["node/bin/node", "host/runtimeHost.mjs", "host/authHost.mjs", "node_modules/@cursor/sdk/package.json"]) {
  assert.ok(manifest.files[relative], `Critical asset not inventoried: ${relative}`);
}
for (const [relative, digest] of Object.entries(manifest.files)) {
  assert.equal(hash(readFileSync(confined(relative))), digest, `Packaged asset hash mismatch: ${relative}`);
}
for (const relative of walk(assetRoot)) {
  assert.ok(relative === "manifest.json" || manifest.files[relative], `Uninventoried packaged asset: ${relative}`);
}
const nodeVersion = execFileSync(confined("node/bin/node"), ["--version"], { encoding: "utf8", timeout: 10000, env: { PATH: "/usr/bin:/bin" } }).trim();
assert.equal(nodeVersion, "v24.15.0");

const archive = path.join(resources, "app.asar");
const archivedFiles = asar.listPackage(archive);
assert.ok(!archivedFiles.some((name) => /\/runtime-assets(?:\/|$)/.test(name)), "Staging assets/cache leaked into ASAR");
const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
assert.match(pkg.version, /^\d+\.\d+\.\d+-cursor-sdk\.\d+$/);
const infoVersion = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(appPath, "Contents/Info.plist")], { encoding: "utf8" }).trim();
assert.equal(infoVersion, pkg.version);

// The generated main-process distribution is an owned byte contract. Check
// exact archive membership and hashes: this catches orphaned old lazy chunks.
const builtFiles = readdirSync(path.join(appRoot, "dist")).filter((file) => /\.(?:js|cjs)$/.test(file)).sort();
const packedFiles = archivedFiles.filter((file) => /^\/dist\/[^/]+\.(?:js|cjs)$/.test(file)).map((file) => file.slice("/dist/".length)).sort();
assert.deepEqual(packedFiles, builtFiles, "Packaged main chunks differ from current build");
for (const file of builtFiles) {
  const packed = asar.extractFile(archive, `dist/${file}`);
  assert.equal(hash(packed), hash(readFileSync(path.join(appRoot, "dist", file))), `Stale packaged chunk: ${file}`);
  assert.ok(!/__RAFT_(COMPUTER|DAEMON|CLI)_VERSION__/.test(packed.toString("utf8")), `Unresolved embedded version: ${file}`);
}
assert.ok(archivedFiles.includes("/dist/frontend/index.html"), "Bundled frontend missing");
const cliPath = path.join(appRoot, "../../packages/cli/dist/index.js");
assert.equal(hash(readFileSync(path.join(resources, "cli/index.js"))), hash(readFileSync(cliPath)), "Bundled CLI is stale");

console.log(JSON.stringify({
  check: "cursor-sdk-packaged-app", result: "passed", appPath,
  version: pkg.version, target: manifest.target, sdkVersion: manifest.sdkVersion,
  nodeVersion, assetFilesVerified: Object.keys(manifest.files).length,
  mainChunksVerified: builtFiles.length, staleChunks: 0, asarStagingCopies: 0,
  frontendPresent: true, bundledCliCurrent: true,
  signing: "local-test-build; not Developer-ID signed or notarized",
}, null, 2));
