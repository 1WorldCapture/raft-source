// Guard rail for the SEA packaging of the pi runtime (PR review follow-up on the
// pi 1.1.0 upgrade): the Computer SEA inlines daemon + every JS dependency via
// esbuild, but file assets shipped inside those packages (.wasm/.node/.so) are
// NOT inlined — only assets with an explicit sidecar step make it into the
// distribution. Today that is exactly one: photon (copyPhotonWasmSidecar in
// build.mjs).
//
// The gap this module guards: pi 1.1.0 added quickjs-wasi (quickjs.wasm + five
// .so extensions) whose loader resolves the file from node_modules at RUNTIME.
// It is unreachable today — codemode is a built-in pi extension loaded only by
// pi's own CLI entry, never by the daemon's SDK path — so the SEA is safe, but
// a future pi that loads it (or any other new asset-bearing dependency) would
// fail only when the feature is used. Smoke tests cannot see lazy paths like
// this, so the build itself reports the inventory instead.
//
// Behavior is WARN-only by design (PM decision 2026-10-11): unlisted assets
// must not fail the build — the author decides whether the asset is genuinely
// reachable and either adds a sidecar + whitelist entry or accepts the warning.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, posix, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** File extensions that only work in a SEA distribution via a sidecar copy. */
export const PI_ASSET_EXTENSIONS = new Set([".wasm", ".node", ".so"]);

/** Assets the build already ships as sidecars (package name -> file basenames).
 *  Anything else found in the pi runtime closure produces a warning. */
export const SIDECAR_HANDLED = new Map([
  ["@silvia-odwyer/photon-node", new Set(["photon_rs_bg.wasm"])],
]);

// Directories that never hold production assets — test/doc fixtures inside
// packages would only produce noise.
const SKIP_DIRS = new Set([
  "node_modules",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "examples",
  "docs",
]);

/** Default dependency resolution: `name/package.json` from the dependent's
 *  directory (handles the pnpm symlink layout), falling back to the package
 *  entry point and walking up to its package.json. Returns null when the
 *  dependency cannot be resolved (optional/peer/platform package that is not
 *  installed) — the scan skips it; this is a warning rail, not a hard gate. */
function defaultResolveDependencyDir(fromPkgDir, name) {
  const require = createRequire(pathToFileURL(join(fromPkgDir, "package.json")));
  for (const spec of [`${name}/package.json`, name]) {
    try {
      const resolved = require.resolve(spec);
      // Walk up from the resolved file to the nearest package.json.
      let dir = dirname(resolved);
      for (let i = 0; i < 8; i += 1) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          if (pkg.name === name) return dir;
        } catch {
          /* keep walking */
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* try next spec */
    }
  }
  return null;
}

/** Default asset listing: recursive walk of the package directory, skipping
 *  test/doc directories, returning POSIX-style relative paths. */
function defaultListAssets(pkgDir) {
  const found = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(pkgDir, rel), { withFileTypes: true });
    } catch {
      return; // unreadable — nothing to report
    }
    for (const entry of entries) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(relPath);
      } else if (PI_ASSET_EXTENSIONS.has(extname(entry.name))) {
        found.push(relPath);
      }
    }
  };
  walk("");
  return found.sort();
}

/**
 * @typedef {object} PiAssetScanDeps
 * @property {(pkgDir: string) => Record<string, unknown> | null} [readPackageJson]
 * @property {(fromPkgDir: string, name: string) => string | null} [resolveDependencyDir]
 * @property {(pkgDir: string) => string[]} [listAssets]
 * @property {(p: string) => string} [realpath]
 *
 * @typedef {object} PiAssetWarning
 * @property {string} package
 * @property {string} packageDir
 * @property {string[]} assets
 *
 * @typedef {object} PiAssetScanResult
 * @property {number} packages          Number of packages visited in the runtime closure.
 * @property {string[]} unresolved      Dependencies that could not be resolved (skipped).
 * @property {PiAssetWarning[]} warnings Packages shipping assets with no sidecar handling.
 */

/** Walk pi's RUNTIME dependency closure (dependencies only — dev/peer are
 *  never in the bundle) and collect every package that ships sidecar-class
 *  assets beyond the whitelisted ones. */
export function scanPiRuntimeAssets(piPackageDirInput, deps = {}) {
  const readPackageJson =
    deps.readPackageJson ?? ((dir) => {
      try {
        return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        return null;
      }
    });
  const resolveDependencyDir = deps.resolveDependencyDir ?? defaultResolveDependencyDir;
  const listAssets = deps.listAssets ?? defaultListAssets;
  const realpathImpl = deps.realpath ?? realpathSync;

  let piPackageDir;
  try {
    piPackageDir = realpathImpl(piPackageDirInput);
  } catch {
    return { packages: 0, unresolved: [], warnings: [] }; // tree absent — nothing to scan
  }

  const rootPkg = readPackageJson(piPackageDir);
  const warnings = [];
  const unresolved = [];
  let packages = 0;
  const queue = [{ name: rootPkg?.name ?? "pi-coding-agent", dir: piPackageDir }];
  const seen = new Set([piPackageDir]);

  while (queue.length > 0) {
    const { name, dir } = queue.shift();
    packages += 1;
    const pkg = readPackageJson(dir);
    const dependencies =
      pkg && typeof pkg === "object" && pkg.dependencies && typeof pkg.dependencies === "object"
        ? Object.keys(pkg.dependencies)
        : [];
    for (const dep of dependencies) {
      const depDir = resolveDependencyDir(dir, dep);
      if (depDir === null) {
        // Deduplicated by `dep@dependent` — the same name can fail from many parents.
        const note = `${dep} (from ${name})`;
        if (!unresolved.some((u) => u === note)) unresolved.push(note);
        continue;
      }
      let real;
      try {
        real = realpathImpl(depDir);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const depPkg = readPackageJson(real);
      queue.push({ name: depPkg?.name ?? dep, dir: real });
    }

    // Extension filtering + ordering live here, not only in defaultListAssets,
    // so any listAssets source yields the same deterministic asset list.
    const assets = listAssets(dir)
      .filter((asset) => PI_ASSET_EXTENSIONS.has(extname(asset)))
      .sort();
    if (assets.length === 0) continue;
    const handled = SIDECAR_HANDLED.get(name) ?? new Set();
    const unhandled = assets.filter((asset) => !handled.has(posix.basename(asset)));
    if (unhandled.length > 0) {
      warnings.push({ package: name, packageDir: dir, assets: unhandled });
    }
  }
  return { packages, unresolved, warnings };
}

/** Build-script entry: resolve the daemon's pi install and print warnings.
 *  Silent when the daemon tree is absent (dependency-freshness reports that). */
export function warnPiAssetGaps(daemonRoot) {
  let piDir;
  try {
    piDir = realpathSync(join(daemonRoot, "node_modules", "@earendil-works", "pi-coding-agent"));
  } catch {
    return;
  }
  const { warnings } = scanPiRuntimeAssets(piDir);
  for (const warning of warnings) {
    console.warn(
      `[build] WARNING: pi runtime dependency "${warning.package}" ships asset(s) with no SEA sidecar: ` +
        `${warning.assets.join(", ")} — esbuild inlines JS only; if this asset is reachable at ` +
        `runtime, add a sidecar step + whitelist entry (see copyPhotonWasmSidecar).`,
    );
  }
}
