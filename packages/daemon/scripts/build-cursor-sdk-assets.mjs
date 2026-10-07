#!/usr/bin/env node
/**
 * Cursor SDK runtime-asset builder (assets worker ownership).
 *
 * Stages the external, self-contained runtime assets for the `cursor-sdk`
 * runtime id into:
 *
 *   packages/daemon/runtime-assets/cursor/<sdkVersion>/<target>/
 *     manifest.json            integrity manifest (resolver contract)
 *     node/                    official Node v24.15.0 distribution
 *     node_modules/            @cursor/sdk@1.0.36 + full movable production closure
 *     host/runtimeHost.mjs     run host (transpiled from src/cursorSdk/runtimeHost.ts)
 *     host/authHost.mjs        auth host (transpiled from src/cursorSdk/authHost.ts)
 *
 * Hard rules enforced here (see docs/architecture/cursor-sdk-implementation.md):
 *   - @cursor/sdk must be the EXACT original npm package (pinned in
 *     ../cursor-sdk-assets.lock.json with the registry integrity sha512) with
 *     its full lazy chunks — never repackaged, never patched, and never
 *     bundled into the Electron/SEA host.
 *   - Node must be the official v24.15.0 distribution, sha256-verified
 *     against BOTH the freshly downloaded SHASUMS256.txt and the pin in the
 *     lock file.
 *   - Host entries are transpiled with @cursor/sdk external; the SDK is
 *     resolved at runtime from the staged node_modules closure.
 *   - Integrity chain (integration review, Assets): for registry-staged
 *     packages the tarball sha512 IS proof the original published bytes were
 *     extracted; the generated manifest then pins every staged file's SHA256,
 *     and the daemon re-verifies that inventory before credential use
 *     (verifyCursorSdkAssetsIntegrity) and at packaging time (--verify).
 *     A package.json version check alone proves nothing and is never the
 *     gate.
 *
 * Usage:
 *   pnpm --filter @botiverse/raft-daemon build:cursor-assets [-- <flags>]
 *
 * Flags:
 *   --target <platform>-<arch>      staged target (default: this machine)
 *   --only sdk,node,hosts,manifest  run a subset of steps
 *   --sdk-from-local <dir>          copy the SDK closure from an existing
 *                                   node_modules dir (offline; versions still
 *                                   checked against the lock, provenance marked
 *                                   local-copy instead of registry-verified)
 *   --node-from-local <path>        offline Node source: a tarball (still
 *                                   sha256-verified against the lock) or an
 *                                   extracted distribution dir containing
 *                                   bin/node (verified via `bin/node --version`)
 *   --allow-missing-hosts           write the manifest with hosts:"missing"
 *                                   (dev staging only; the daemon resolver
 *                                   refuses such roots)
 *   --verify                        verify an already staged target against its
 *                                   manifest + lock, then exit
 *   --require-registry              with --verify: additionally require the
 *                                   staged root to carry registry/dist
 *                                   provenance (SDK from npm-registry,
 *                                   Node from nodejs.org or a sha256-verified
 *                                   local tarball) — use for release packaging,
 *                                   where local-copy dev provenance must fail
 *   --skip-shasums-fetch            offline: trust the lock pin only (the
 *                                   artifact is still sha256-verified; skips
 *                                   the fresh SHASUMS256.txt cross-check)
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCK_PATH = path.join(DAEMON_ROOT, "cursor-sdk-assets.lock.json");
// Staging base override (tests / CI staging into a workspace): set
// RAFT_CURSOR_ASSETS_BASE to an absolute dir. Release builds leave it unset so
// assets always stage into the daemon's own runtime-assets tree, which is also
// the resolver's dev-discovery contract.
const ASSETS_BASE = process.env.RAFT_CURSOR_ASSETS_BASE
  ? path.resolve(process.env.RAFT_CURSOR_ASSETS_BASE)
  : path.join(DAEMON_ROOT, "runtime-assets", "cursor");
// The versioned layout is the resolver's dev-discovery contract:
// runtime-assets/cursor/<sdkVersion>/<target> (see src/cursorSdk/assets.ts).
const CACHE_DIR = path.join(ASSETS_BASE, ".cache");
const MANIFEST_SCHEMA_VERSION = 1;
const BUILDER_VERSION = 1;
const STEPS = ["sdk", "node", "hosts", "manifest"];

const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
const SDK_VERSION = lock.sdkVersion;
const NODE_VERSION = lock.nodeVersion;

function fail(message) {
  process.stderr.write(`build-cursor-sdk-assets: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {
    target: `${process.platform}-${process.arch}`,
    only: null,
    sdkFromLocal: null,
    nodeFromLocal: null,
    allowMissingHosts: false,
    verify: false,
    skipShasumsFetch: false,
    requireRegistry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm may forward its option separator to package scripts.
    if (arg === "--") continue;
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === "--target") flags.target = next();
    else if (arg === "--only") flags.only = next().split(",").map((s) => s.trim());
    else if (arg === "--sdk-from-local") flags.sdkFromLocal = next();
    else if (arg === "--node-from-local") flags.nodeFromLocal = next();
    else if (arg === "--allow-missing-hosts") flags.allowMissingHosts = true;
    else if (arg === "--verify") flags.verify = true;
    else if (arg === "--require-registry") flags.requireRegistry = true;
    else if (arg === "--skip-shasums-fetch") flags.skipShasumsFetch = true;
    else fail(`unknown flag ${arg}`);
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const targetDir = path.join(ASSETS_BASE, SDK_VERSION, flags.target);

const KNOWN_TARGETS = new Set([...Object.keys(lock.node.archives), ...Object.keys(lock.sdk.platformPackages)]);
if (!KNOWN_TARGETS.has(flags.target)) {
  fail(
    `target ${flags.target} has no pinned artifacts in cursor-sdk-assets.lock.json; known targets: ${[
      ...KNOWN_TARGETS,
    ].join(", ")}`,
  );
}

function log(message) {
  process.stdout.write(`[cursor-assets] ${message}\n`);
}

function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}

function sha512FileBase64(file) {
  const hash = createHash("sha512");
  hash.update(readFileSync(file));
  return hash.digest("base64");
}

async function downloadTo(url, dest) {
  // Written via a temp file first so a partial download never poisons the cache.
  const tmp = `${dest}.download-${process.pid}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
    renameSync(tmp, dest);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

async function fetchCached(url, dest, expectedHex) {
  if (existsSync(dest)) {
    const seen = sha256File(dest);
    if (!expectedHex || seen === expectedHex) {
      log(`cache hit ${path.basename(dest)}`);
      return;
    }
    log(`cache stale ${path.basename(dest)}; redownloading`);
    rmSync(dest, { force: true });
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  log(`downloading ${url}`);
  await downloadTo(url, dest);
  if (expectedHex && sha256File(dest) !== expectedHex) {
    fail(`downloaded ${url} does not match the pinned sha256 (corrupted download or stale pin)`);
  }
}

function extractTar(file, destDir, { strip = 0 } = {}) {
  mkdirSync(destDir, { recursive: true });
  const args = ["-xf", file, "-C", destDir];
  if (strip > 0) args.push("--strip-components", String(strip));
  try {
    execFileSync("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fail(`tar extraction failed for ${file}: ${String(error)}`);
  }
}

function swapIn(stagingDir, finalDir) {
  rmSync(finalDir, { recursive: true, force: true });
  mkdirSync(path.dirname(finalDir), { recursive: true });
  renameSync(stagingDir, finalDir);
}

function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
      // Symlinks inside npm packages (none expected in this closure) are
      // rejected loudly rather than silently dereferenced or dropped.
      else if (entry.isSymbolicLink()) fail(`unexpected symlink in staged assets: ${full}`);
    }
  };
  walk(root);
  out.sort();
  return out;
}

function buildFileInventory(root, { skip = [] } = {}) {
  const skipSet = new Set(skip);
  const files = {};
  for (const rel of listFilesRecursive(root)) {
    if (skipSet.has(rel)) continue;
    files[rel] = sha256File(path.join(root, rel));
  }
  return files;
}

function runCapture(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

// ─── step: sdk closure ─────────────────────────────────────────────────────

function sdkClosurePackages(target) {
  const closure = { ...lock.sdk.packages };
  const platform = lock.sdk.platformPackages[target];
  if (!platform) fail(`no platform package pinned for target ${target}`);
  closure[platform.name] = platform;
  return closure;
}

function verifyStagedClosureVersions(nodeModulesDir, target) {
  for (const [name, pinned] of Object.entries(sdkClosurePackages(target))) {
    const pkgPath = path.join(nodeModulesDir, ...name.split("/"), "package.json");
    if (!existsSync(pkgPath)) fail(`SDK closure is missing ${name}@${pinned.version} at ${pkgPath}`);
    const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    if (version !== pinned.version) {
      fail(`${name}@${version} does not match the pinned ${pinned.version}; refusing to stage`);
    }
  }
}

async function stageSdk(target) {
  const finalDir = path.join(targetDir, "node_modules");
  const staging = mkdtempSync(path.join(ASSETS_BASE, ".staging-sdk-"));
  const stagedNodeModules = path.join(staging, "node_modules");
  try {
    let provenance;
    if (flags.sdkFromLocal) {
      stageSdkFromLocal(stagedNodeModules, target);
      provenance = { source: "local-copy", note: `copied from ${flags.sdkFromLocal}; versions lock-verified` };
    } else {
      await stageSdkFromRegistry(stagedNodeModules, target);
      provenance = { source: "npm-registry", note: "tarball sha512 verified against registry integrity pin" };
    }
    verifyStagedClosureVersions(stagedNodeModules, target);
    swapIn(stagedNodeModules, finalDir);
    return provenance;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function stageSdkFromLocal(destNodeModules, target) {
  const sourceRoot = path.resolve(flags.sdkFromLocal);
  if (!existsSync(sourceRoot)) fail(`--sdk-from-local ${sourceRoot} does not exist`);
  for (const [name, pinned] of Object.entries(sdkClosurePackages(target))) {
    const src = path.join(sourceRoot, name);
    const pkgJsonPath = path.join(src, "package.json");
    if (!existsSync(pkgJsonPath)) {
      fail(`--sdk-from-local is missing ${name}@${pinned.version} (expected at ${src})`);
    }
    const version = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;
    if (version !== pinned.version) {
      fail(`--sdk-from-local has ${name}@${version}, but the lock pins ${pinned.version}`);
    }
    const dest = path.join(destNodeModules, ...name.split("/"));
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    log(`copied ${name}@${version} from local install`);
  }
}

async function stageSdkFromRegistry(destNodeModules, target) {
  for (const [name, pinned] of Object.entries(sdkClosurePackages(target))) {
    const expected = pinned.integrity;
    if (!expected.startsWith("sha512-")) fail(`lock entry ${name} lacks a sha512 integrity value`);
    const cacheFile = path.join(CACHE_DIR, `${name.replace("/", "+")}-${pinned.version}.tgz`);
    await fetchCached(pinned.url, cacheFile, null);
    // The sha512 pin IS the registry's official integrity record for the exact
    // tarball bytes; cache hits are re-verified so a corrupted cache can never
    // be staged.
    const actual = `sha512-${sha512FileBase64(cacheFile)}`;
    if (actual !== expected) {
      fail(
        `${name}@${pinned.version} tarball integrity mismatch:\n  expected ${expected}\n  actual   ${actual}\nDelete ${cacheFile} and retry.`,
      );
    }
    const dest = path.join(destNodeModules, ...name.split("/"));
    mkdirSync(path.dirname(dest), { recursive: true });
    extractTar(cacheFile, dest, { strip: 1 });
    log(`staged ${name}@${pinned.version} (registry integrity verified)`);
  }
}

// ─── step: node distribution ───────────────────────────────────────────────

async function stageNode(target) {
  const archive = lock.node.archives[target];
  if (!archive) fail(`no Node ${NODE_VERSION} archive pinned for ${target}`);
  const staging = mkdtempSync(path.join(ASSETS_BASE, ".staging-node-"));
  try {
    const provenance = flags.nodeFromLocal
      ? stageNodeFromLocal(staging, archive)
      : await stageNodeFromDist(staging, archive);
    swapIn(path.join(staging, "node"), path.join(targetDir, "node"));
    return provenance;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function stageNodeFromLocal(staging, archive) {
  const local = path.resolve(flags.nodeFromLocal);
  if (!existsSync(local)) fail(`--node-from-local ${local} does not exist`);
  if (statSync(local).isFile()) {
    const seen = sha256File(local);
    if (seen !== archive.sha256) {
      fail(
        `--node-from-local tarball sha256 ${seen} does not match the pinned official checksum ${archive.sha256}`,
      );
    }
    extractIntoNodeDir(staging, local);
    return { source: "local-tarball", note: "sha256 verified against lock pin" };
  }
  const binNode = path.join(local, "bin", "node");
  if (!existsSync(binNode)) fail(`--node-from-local dir ${local} has no bin/node`);
  const version = runCapture(binNode, ["--version"]).trim();
  if (version !== `v${NODE_VERSION}`) {
    fail(`--node-from-local bin/node --version returned ${version}, expected v${NODE_VERSION}`);
  }
  cpSync(local, path.join(staging, "node"), { recursive: true, dereference: true });
  return {
    source: "local-dir",
    note: "version probed via bin/node --version; no archive checksum available",
  };
}

async function stageNodeFromDist(staging, archive) {
  if (!flags.skipShasumsFetch) {
    // Cross-check the lock pin against the official SHASUMS256.txt every
    // online build: a stale or tampered pin must never pass silently.
    const shasumsPath = path.join(CACHE_DIR, `SHASUMS256.txt-v${NODE_VERSION}`);
    await fetchCached(lock.node.shasumsUrl, shasumsPath, null);
    let freshEntry = null;
    for (const line of readFileSync(shasumsPath, "utf8").split("\n")) {
      const match = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
      if (match && match[2] === archive.file) freshEntry = match[1];
    }
    if (!freshEntry) fail(`${archive.file} missing from ${lock.node.shasumsUrl}`);
    if (freshEntry !== archive.sha256) {
      fail(
        `official SHASUMS256.txt says ${archive.file} is ${freshEntry}, but the lock pins ${archive.sha256}; the pin is stale or wrong — fix the lock before staging`,
      );
    }
  }
  const archivePath = path.join(CACHE_DIR, archive.file);
  await fetchCached(`${lock.node.base}/${archive.file}`, archivePath, archive.sha256);
  extractIntoNodeDir(staging, archivePath);
  return {
    source: "nodejs.org",
    note: flags.skipShasumsFetch
      ? "sha256 verified against lock pin only (--skip-shasums-fetch)"
      : "sha256 verified against lock pin and fresh SHASUMS256.txt",
  };
}

function extractIntoNodeDir(staging, archivePath) {
  const extractRoot = path.join(staging, "extract");
  extractTar(archivePath, extractRoot);
  const entries = readdirSync(extractRoot);
  if (entries.length !== 1) fail(`unexpected Node archive layout in ${archivePath}`);
  const dist = path.join(extractRoot, entries[0]);
  if (!existsSync(path.join(dist, "bin", "node"))) fail(`Node archive ${archivePath} has no bin/node`);
  // Ship only the execution engine and its license. npm/corepack are not
  // needed at runtime and their distribution symlinks are intentionally not
  // admitted by the asset manifest's no-symlink invariant.
  const nodeRoot = path.join(staging, "node");
  mkdirSync(path.join(nodeRoot, "bin"), { recursive: true });
  cpSync(path.join(dist, "bin", "node"), path.join(nodeRoot, "bin", "node"));
  if (existsSync(path.join(dist, "LICENSE"))) cpSync(path.join(dist, "LICENSE"), path.join(nodeRoot, "LICENSE"));
  rmSync(extractRoot, { recursive: true, force: true });
}

// ─── step: host entries ────────────────────────────────────────────────────

async function stageHosts() {
  const sources = {
    runtimeHost: path.join(DAEMON_ROOT, "src", "cursorSdk", "runtimeHostEntry.ts"),
    authHost: path.join(DAEMON_ROOT, "src", "cursorSdk", "authHostEntry.ts"),
  };
  const missing = Object.entries(sources)
    .filter(([, src]) => !existsSync(src))
    .map(([name]) => name);
  if (missing.length > 0) {
    if (!flags.allowMissingHosts) {
      fail(
        `host source entries missing: ${missing.join(", ")} (owned by the runtime/auth workers). ` +
          `Re-run after they land, or pass --allow-missing-hosts for dev staging.`,
      );
    }
    log(`WARNING: staging without host entries (${missing.join(", ")}); the resolver rejects this root`);
    rmSync(path.join(targetDir, "host"), { recursive: true, force: true });
    return "missing";
  }
  let esbuild;
  try {
    esbuild = (await import("esbuild")).default;
  } catch {
    fail(
      "esbuild is not installed (needed to transpile the host entries); run `pnpm install` in the workspace root",
    );
  }
  const staging = mkdtempSync(path.join(ASSETS_BASE, ".staging-hosts-"));
  try {
    await esbuild.build({
      entryPoints: sources,
      outdir: staging,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      format: "esm",
      platform: "node",
      target: `node${NODE_VERSION.split(".")[0]}`,
      // The SDK must stay external: it is resolved at runtime from the staged
      // node_modules closure, never inlined into the host or the daemon.
      external: ["@cursor/sdk", "@cursor/sdk/*"],
      legalComments: "none",
      sourcemap: false,
      logLevel: "warning",
    });
    swapIn(staging, path.join(targetDir, "host"));
    log("transpiled host entries (external @cursor/sdk)");
    return "present";
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ─── step: manifest ────────────────────────────────────────────────────────

function provenancePath() {
  return path.join(targetDir, ".provenance.json");
}

function readProvenance() {
  if (existsSync(provenancePath())) return JSON.parse(readFileSync(provenancePath(), "utf8"));
  const previous = path.join(targetDir, "manifest.json");
  return existsSync(previous) ? JSON.parse(readFileSync(previous, "utf8")).provenance ?? {} : {};
}

function writeProvenance(update) {
  writeFileSync(provenancePath(), `${JSON.stringify({ ...readProvenance(), ...update }, null, 2)}\n`);
}

async function stageManifest() {
  const sdkDir = path.join(targetDir, "node_modules");
  const nodeDir = path.join(targetDir, "node");
  if (!existsSync(sdkDir)) fail("sdk closure not staged; run the sdk step first (drop --only or add sdk)");
  if (!existsSync(nodeDir)) fail("node distribution not staged; run the node step first (drop --only or add node)");
  const hostsStatus = existsSync(path.join(targetDir, "host", "runtimeHost.mjs"))
    ? "present"
    : flags.allowMissingHosts
      ? "missing"
      : fail("host entries not staged (run all steps, or --allow-missing-hosts for dev staging)");

  verifyStagedClosureVersions(sdkDir, flags.target);

  log("hashing staged files for the integrity manifest…");
  const files = buildFileInventory(targetDir, { skip: ["manifest.json", ".provenance.json"] });
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    builderVersion: BUILDER_VERSION,
    createdAt: new Date().toISOString(),
    sdkVersion: SDK_VERSION,
    nodeVersion: NODE_VERSION,
    target: flags.target,
    hosts: hostsStatus,
    entries: {
      nodePath: "node/bin/node",
      runtimeEntryPath: "host/runtimeHost.mjs",
      authEntryPath: "host/authHost.mjs",
      sdkRoot: "node_modules/@cursor/sdk",
    },
    provenance: readProvenance(),
    files,
  };
  const manifestTmp = `${path.join(targetDir, "manifest.json")}.tmp`;
  writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(manifestTmp, path.join(targetDir, "manifest.json"));
  rmSync(provenancePath(), { force: true });
  log(`manifest written: ${Object.keys(files).length} files hashed`);
}


/**
 * Manifest inventory keys are untrusted input: a hostile or corrupt manifest
 * could name ../../../etc/passwd. Only plain relative, non-escaping paths
 * inside the staged root are ever joined.
 */
function confinedRelative(rel) {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return false;
  if (path.isAbsolute(rel) || /^\s*[a-zA-Z]:/.test(rel)) return false;
  const segments = rel.split(/[\\/]+/);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

// ─── verify mode ───────────────────────────────────────────────────────────

function verifyStaged() {
  const manifestFile = path.join(targetDir, "manifest.json");
  if (!existsSync(manifestFile)) fail(`no manifest.json at ${targetDir}; nothing to verify`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) fail("unsupported manifest schemaVersion");
  if (manifest.sdkVersion !== SDK_VERSION || manifest.nodeVersion !== NODE_VERSION) {
    fail(`manifest versions ${manifest.sdkVersion}/${manifest.nodeVersion} != pinned ${SDK_VERSION}/${NODE_VERSION}`);
  }
  let problems = 0;
  const pinnedFiles = manifest.files ?? {};
  for (const [rel, expected] of Object.entries(pinnedFiles)) {
    if (!confinedRelative(rel)) {
      process.stderr.write(`manifest inventory path escapes asset root: ${rel}\n`);
      problems++;
      continue;
    }
    const full = path.join(targetDir, rel);
    if (!existsSync(full) || sha256File(full) !== expected) {
      process.stderr.write(`integrity mismatch: ${rel}\n`);
      problems++;
      if (problems >= 20) {
        process.stderr.write("…stopping after 20 problems\n");
        break;
      }
    }
  }
  // Unmanifested extra files fail verification too.
  for (const rel of Object.keys(buildFileInventory(targetDir, { skip: ["manifest.json"] }))) {
    if (!(rel in pinnedFiles)) {
      process.stderr.write(`unmanifested file: ${rel}\n`);
      problems++;
    }
  }
  if (problems > 0) fail(`${problems} integrity problem(s) at ${targetDir}`);

  // Release packaging gate: assets staged from local-copy/local-dir sources
  // are dev conveniences; a packaged app must prove registry/dist provenance.
  if (flags.requireRegistry) {
    const provenance = manifest.provenance ?? {};
    const sdkSource = provenance.sdk?.source ?? "unknown";
    const nodeSource = provenance.node?.source ?? "unknown";
    const sdkOk = sdkSource === "npm-registry";
    const nodeOk = nodeSource === "nodejs.org" || nodeSource === "local-tarball";
    if (!sdkOk || !nodeOk) {
      fail(
        `--require-registry: staged provenance is sdk=${sdkSource} node=${nodeSource}, but release packaging requires sdk=npm-registry and node=nodejs.org (or a sha256-verified local tarball). Restage without --sdk-from-local/--node-from-local <dir>.`,
      );
    }
  }

  // The staged node can only be executed on its own platform/arch. A
  // cross-target verify (e.g. a Linux box checking darwin assets) relies on
  // the manifest hashes above — the node distribution is sha256-pinned to the
  // official checksum — and skips the execution probe.
  let nodeNote;
  if (flags.target === `${process.platform}-${process.arch}`) {
    const nodeBin = path.join(targetDir, "node", "bin", "node");
    const version = runCapture(nodeBin, ["--version"]).trim();
    if (version !== `v${NODE_VERSION}`) fail(`staged node reports ${version}, expected v${NODE_VERSION}`);
    nodeNote = `node ${version}`;
  } else {
    nodeNote = `node execution probe skipped (cross-target from ${process.platform}-${process.arch})`;
  }

  verifyNoSdkBundled();
  log(`verified ${Object.keys(pinnedFiles).length} files; ${nodeNote}; target ${flags.target}`);
}

function verifyNoSdkBundled() {
  // Guard the "SDK never in the Electron/SEA bundle" invariant on whatever
  // daemon/desktop dist exists next to this checkout.
  const importPattern = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@cursor\/sdk(?:\/[^"']*)?["']/;
  const daemonDist = path.join(DAEMON_ROOT, "dist");
  if (existsSync(daemonDist)) {
    for (const file of readdirSync(daemonDist)) {
      if (!/\.(js|mjs)$/.test(file)) continue;
      if (importPattern.test(readFileSync(path.join(daemonDist, file), "utf8"))) {
        fail(`dist/${file} runtime-imports @cursor/sdk — the SDK must stay external (staged assets only)`);
      }
    }
  }
  const desktopDist = path.join(DAEMON_ROOT, "..", "..", "apps", "raft-desktop-electron", "dist");
  if (existsSync(desktopDist)) {
    let offenders = 0;
    for (const file of readdirSync(desktopDist)) {
      if (!/\.(js|mjs)$/.test(file)) continue;
      if (importPattern.test(readFileSync(path.join(desktopDist, file), "utf8"))) offenders++;
    }
    if (offenders > 0) {
      process.stderr.write(
        `WARNING: ${offenders} desktop dist file(s) import @cursor/sdk; rebuild the desktop bundle after the daemon stops referencing it\n`,
      );
    }
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(ASSETS_BASE, { recursive: true });
  // Sweep stale staging dirs from crashed/killed runs (a fail() inside a step
  // exits without unwinding finally blocks; leftover .staging-* dirs would
  // otherwise accumulate and never appear in any manifest).
  if (existsSync(ASSETS_BASE)) {
    for (const entry of readdirSync(ASSETS_BASE)) {
      if (entry.startsWith(".staging-")) {
        rmSync(path.join(ASSETS_BASE, entry), { recursive: true, force: true });
        log(`swept stale ${entry}`);
      }
    }
  }
  if (flags.verify) {
    verifyStaged();
    process.stdout.write(`OK ${targetDir}\n`);
    return;
  }
  const steps = flags.only ?? STEPS;
  for (const step of steps) {
    if (!STEPS.includes(step)) fail(`unknown step ${step}`);
  }
  // A host-only rebuild may retain dependency provenance only when those
  // dependency bytes still match the previous verified inventory.
  const priorManifestPath = path.join(targetDir, "manifest.json");
  if (existsSync(priorManifestPath)) {
    const prior = JSON.parse(readFileSync(priorManifestPath, "utf8"));
    for (const [rel, digest] of Object.entries(prior.files ?? {})) {
      const retained = (rel.startsWith("node_modules/") && !steps.includes("sdk"))
        || (rel.startsWith("node/") && !steps.includes("node"));
      if (retained && (!confinedRelative(rel) || !existsSync(path.join(targetDir, rel)) || sha256File(path.join(targetDir, rel)) !== digest)) {
        fail("retained runtime dependency changed; perform a full sdk,node restage");
      }
    }
  }
  const provenance = {};
  if (steps.includes("sdk")) provenance.sdk = await stageSdk(flags.target);
  if (steps.includes("node")) provenance.node = await stageNode(flags.target);
  if (steps.includes("sdk") || steps.includes("node")) writeProvenance(provenance);
  if (steps.includes("hosts")) writeProvenance({ hosts: await stageHosts() });
  if (steps.includes("manifest")) await stageManifest();

  process.stdout.write(
    [
      `staged target: ${flags.target}`,
      `asset root:    ${targetDir}`,
      `resolver env:  RAFT_CURSOR_SDK_ASSETS=${targetDir}`,
      `dev discovery: packages/daemon/runtime-assets/cursor/${SDK_VERSION}/${flags.target} (this run staged into ${ASSETS_BASE})`,
    ].join("\n") + "\n",
  );
}

main().catch((error) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
