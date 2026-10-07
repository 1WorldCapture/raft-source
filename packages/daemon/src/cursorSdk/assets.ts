/**
 * Cursor SDK runtime-asset resolution (runtime id `cursor-sdk`).
 *
 * OWNERSHIP: assets worker — see docs/architecture/cursor-sdk-implementation.md.
 *
 * The `cursor-sdk` runtime does NOT run @cursor/sdk in the daemon process and
 * the SDK is never bundled into the Electron/SEA host. Instead a self-contained
 * asset root is staged by `packages/daemon/scripts/build-cursor-sdk-assets.mjs`
 * (pinned by `packages/daemon/cursor-sdk-assets.lock.json`) with this layout:
 *
 * ```
 * <assetRoot>/
 *   manifest.json                     integrity manifest (this module's contract)
 *   node/bin/node                     official Node v24.15.0 (checksum-verified at staging)
 *   node_modules/@cursor/sdk          exact original package @1.0.36, full lazy chunks
 *   node_modules/@cursor/sdk-<plat>-<arch>   platform helper (rg / cursorsandbox / vendor)
 *   node_modules/<closure deps>       complete movable production closure
 *   host/runtimeHost.mjs              run host entry (transpiled, external @cursor/sdk)
 *   host/authHost.mjs                 auth host entry (transpiled, external @cursor/sdk)
 * ```
 *
 * Resolution order (host-owner env first, exact root, no fallback):
 *   1. `RAFT_CURSOR_SDK_ASSETS` — set by the desktop host from
 *      `process.resourcesPath` BEFORE importing the daemon. This is the only
 *      path selection trusted in release. Per-agent/remote env can never
 *      override it (see CONTROLLED_RUNTIME_ENV_KEYS in packages/shared).
 *   2. Development default: discover
 *      `<daemonRoot>/runtime-assets/cursor/<CURSOR_SDK_VERSION>/<platform>-<arch>`
 *      by walking up from this module (works from `src/` via tsx and from the
 *      daemon `dist/`; never inside an Electron/SEA bundle, which has no such
 *      ancestor). Final dev path on this machine:
 *      `packages/daemon/runtime-assets/cursor/1.0.36/darwin-arm64`.
 *
 * Both resolution paths validate the same manifest contract and throw the same
 * sanitized, actionable typed errors. This module performs filesystem checks
 * only: it never imports @cursor/sdk, spawns processes, or touches the network.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Exact @cursor/sdk version the runtime assets must contain. */
export const CURSOR_SDK_VERSION = "1.0.36";

/** Exact official Node version staged as the external run/auth host. */
export const CURSOR_NODE_VERSION = "24.15.0";

/**
 * Host-owner env var denoting the EXACT asset root. Set by the desktop app
 * from `process.resourcesPath` before importing the daemon. Never sourced from
 * per-agent or remote-controlled env.
 */
export const RAFT_CURSOR_SDK_ASSETS_ENV = "RAFT_CURSOR_SDK_ASSETS";

/** manifest.json schema this resolver understands. */
const MANIFEST_SCHEMA_VERSION = 1;

/** Where the asset builder places dev assets, relative to the daemon root. */
const DEV_ASSETS_DIRNAME = "runtime-assets";

export interface CursorSdkAssets {
  /** Absolute path of the validated asset root. */
  root: string;
  /** Absolute path of the staged official Node binary. */
  nodePath: string;
  /** Absolute path of the transpiled run-host entry (host/runtimeHost.mjs). */
  runtimeEntryPath: string;
  /** Absolute path of the transpiled auth-host entry (host/authHost.mjs). */
  authEntryPath: string;
  /** Always CURSOR_SDK_VERSION (the manifest must agree). */
  sdkVersion: string;
  /** Always CURSOR_NODE_VERSION (the manifest must agree). */
  nodeVersion: string;
}

export type CursorSdkAssetsErrorKind =
  | "env_root_invalid"
  | "dev_root_not_found"
  | "manifest_invalid"
  | "version_mismatch"
  | "target_mismatch"
  | "missing_node"
  | "missing_entry"
  | "sdk_invalid"
  | "path_escape";

const BUILD_COMMAND = "pnpm --filter @botiverse/raft-daemon build:cursor-assets";

/**
 * Sanitized, actionable typed error. Messages never include env values beyond
 * the asset root path itself (paths are not secrets), never include file
 * contents, and always name the concrete fix.
 */
export class CursorSdkAssetsError extends Error {
  readonly kind: CursorSdkAssetsErrorKind;

  constructor(kind: CursorSdkAssetsErrorKind, message: string) {
    super(message);
    this.name = "CursorSdkAssetsError";
    this.kind = kind;
  }
}

/** Internal seams so tests can drive resolution without touching real env/paths. */
export interface CursorSdkAssetsResolveOptions {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface ManifestShape {
  schemaVersion?: unknown;
  sdkVersion?: unknown;
  nodeVersion?: unknown;
  target?: unknown;
  hosts?: unknown;
  entries?: {
    nodePath?: unknown;
    runtimeEntryPath?: unknown;
    authEntryPath?: unknown;
    sdkRoot?: unknown;
  };
  files?: Record<string, unknown>;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(candidate: string): boolean {
  if (!isFile(candidate)) return false;
  // Windows has no POSIX exec bit; presence of the binary is all we can check.
  if (process.platform === "win32") return true;
  try {
    return (statSync(candidate).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function devHint(target: string): string {
  return `Dev assets are discovered at packages/daemon/runtime-assets/cursor/${CURSOR_SDK_VERSION}/${target}; build them with \`${BUILD_COMMAND}\`.`;
}


/**
 * Manifest entry/inventory paths must be plain relative paths inside the asset
 * root: no absolute paths, no `..` segments (on any separator spelling), no
 * drive letters. Returns true when `rel` is a candidate worth joining.
 */
function isConfinedRelativePath(rel: string): boolean {
  if (rel.length === 0 || rel.includes("\0")) return false;
  if (path.isAbsolute(rel) || /^\s*[a-zA-Z]:/.test(rel)) return false;
  const segments = rel.split(/[\\/]+/);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Join a manifest-declared relative path onto the asset root and prove the
 * result cannot escape: the entry itself must not be a symlink, and its
 * realpath (which resolves every symlinked ancestor) must sit inside the
 * root's realpath. Returns "ok" with the joined path, "missing" when the
 * path simply does not exist (callers report the precise missing-entry
 * error), or "escape" for syntactic escapes, symlinked entries and realpath
 * containment failures (callers raise the typed path_escape error).
 *
 * realpath on both sides also neutralizes host-level symlinked prefixes (e.g.
 * macOS /tmp vs /private/tmp) so containment is judged on real locations.
 */
type ConfinedJoin =
  | { status: "ok"; value: string }
  | { status: "missing" }
  | { status: "escape" };

function confinedJoin(root: string, rootReal: string, rel: string): ConfinedJoin {
  if (!isConfinedRelativePath(rel)) return { status: "escape" };
  const candidate = path.join(root, rel);
  let candidateReal: string;
  try {
    // A symlinked entry is rejected outright (lstat), even when it points
    // back inside the root: entries must be real files/dirs the stager wrote.
    if (lstatSync(candidate).isSymbolicLink()) return { status: "escape" };
    candidateReal = realpathSync(candidate);
  } catch {
    return { status: "missing" };
  }
  if (candidateReal !== rootReal && !candidateReal.startsWith(rootReal + path.sep)) {
    return { status: "escape" };
  }
  return { status: "ok", value: candidate };
}

function realPathOrThrow(root: string): string {
  try {
    return realpathSync(root);
  } catch (error) {
    throw new CursorSdkAssetsError(
      "env_root_invalid",
      `Cursor SDK asset root ${root} cannot be resolved (${error instanceof Error ? error.constructor.name : "unknown error"}). Rebuild with \`${BUILD_COMMAND}\` and point ${RAFT_CURSOR_SDK_ASSETS_ENV} at the rebuilt root.`,
    );
  }
}

/**
 * Validate that `root` is a complete, compatible asset root. Returns the
 * resolved asset paths or throws a {@link CursorSdkAssetsError}.
 */
function validateAssetRoot(root: string, platform: NodeJS.Platform, arch: string): CursorSdkAssets {
  const manifestPath = path.join(root, "manifest.json");
  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestShape;
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : "unknown error";
    throw new CursorSdkAssetsError(
      "manifest_invalid",
      `Cursor SDK assets at ${root} have no readable manifest.json (${reason}). Rebuild the assets with \`${BUILD_COMMAND}\` and point RAFT_CURSOR_SDK_ASSETS at the rebuilt root.`,
    );
  }

  if (
    typeof manifest.schemaVersion !== "number" ||
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION
  ) {
    throw new CursorSdkAssetsError(
      "manifest_invalid",
      `Cursor SDK asset manifest at ${root} has unsupported schemaVersion ${JSON.stringify(
        manifest.schemaVersion,
      )} (expected ${MANIFEST_SCHEMA_VERSION}). Rebuild the assets with \`${BUILD_COMMAND}\`.`,
    );
  }

  if (manifest.sdkVersion !== CURSOR_SDK_VERSION || manifest.nodeVersion !== CURSOR_NODE_VERSION) {
    throw new CursorSdkAssetsError(
      "version_mismatch",
      `Cursor SDK assets at ${root} are sdk ${String(manifest.sdkVersion)} / node ${String(
        manifest.nodeVersion,
      )}, but this daemon requires sdk ${CURSOR_SDK_VERSION} / node ${CURSOR_NODE_VERSION}. Rebuild the assets with \`${BUILD_COMMAND}\`.`,
    );
  }

  const target = `${platform}-${arch}`;
  if (manifest.target !== target) {
    throw new CursorSdkAssetsError(
      "target_mismatch",
      `Cursor SDK assets at ${root} target ${String(manifest.target)}, which cannot run on ${target}. Point RAFT_CURSOR_SDK_ASSETS at ${target} assets (see \`${BUILD_COMMAND} --target ${target}\`).`,
    );
  }

  if (manifest.hosts !== "present") {
    throw new CursorSdkAssetsError(
      "missing_entry",
      `Cursor SDK assets at ${root} were staged without the host entries (hosts=${JSON.stringify(
        manifest.hosts,
      )}). Rebuild with \`${BUILD_COMMAND}\` so host/runtimeHost.mjs and host/authHost.mjs exist.`,
    );
  }

  const entries = manifest.entries ?? {};
  const nodeRel = typeof entries.nodePath === "string" ? entries.nodePath : "";
  const runtimeRel = typeof entries.runtimeEntryPath === "string" ? entries.runtimeEntryPath : "";
  const authRel = typeof entries.authEntryPath === "string" ? entries.authEntryPath : "";
  const sdkRel = typeof entries.sdkRoot === "string" ? entries.sdkRoot : "";
  if (!nodeRel || !runtimeRel || !authRel || !sdkRel) {
    throw new CursorSdkAssetsError(
      "manifest_invalid",
      `Cursor SDK asset manifest at ${root} is missing entry paths (nodePath/runtimeEntryPath/authEntryPath/sdkRoot). Rebuild with \`${BUILD_COMMAND}\`.`,
    );
  }

  // Every manifest-declared path is joined under confinement: relative only,
  // no `..`, no symlinked entry, realpath inside the root's realpath.
  const rootReal = realPathOrThrow(root);
  const manifestEntries = (manifest.entries ?? {}) as Record<string, unknown>;
  const escape = (field: string) =>
    new CursorSdkAssetsError(
      "path_escape",
      `Cursor SDK asset manifest at ${root} declares ${field} outside the asset root (${JSON.stringify(
        manifestEntries[field],
      )}). Manifest paths must be relative and confined to the root. Rebuild with \`${BUILD_COMMAND}\`; a manifest pointing outside its root is corrupt or hostile.`,
    );

  const nodeJoin = confinedJoin(root, rootReal, nodeRel);
  if (nodeJoin.status === "escape") throw escape("nodePath");
  const nodePath = nodeJoin.status === "ok" ? nodeJoin.value : path.join(root, nodeRel);
  if (!isExecutableFile(nodePath)) {
    throw new CursorSdkAssetsError(
      "missing_node",
      `Cursor SDK assets at ${root} are missing the staged Node binary at ${nodeRel}. Rebuild with \`${BUILD_COMMAND}\`.`,
    );
  }

  const runtimeJoin = confinedJoin(root, rootReal, runtimeRel);
  if (runtimeJoin.status === "escape") throw escape("runtimeEntryPath");
  const authJoin = confinedJoin(root, rootReal, authRel);
  if (authJoin.status === "escape") throw escape("authEntryPath");
  const runtimeEntryPath = runtimeJoin.status === "ok" ? runtimeJoin.value : path.join(root, runtimeRel);
  const authEntryPath = authJoin.status === "ok" ? authJoin.value : path.join(root, authRel);
  if (!isFile(runtimeEntryPath) || !isFile(authEntryPath)) {
    throw new CursorSdkAssetsError(
      "missing_entry",
      `Cursor SDK assets at ${root} are missing the host entries ${runtimeRel} and/or ${authRel}. Rebuild with \`${BUILD_COMMAND}\`.`,
    );
  }

  const sdkJoin = confinedJoin(root, rootReal, sdkRel);
  if (sdkJoin.status === "escape") throw escape("sdkRoot");
  const sdkPkgJoin = confinedJoin(root, rootReal, `${sdkRel}/package.json`);
  if (sdkPkgJoin.status === "escape") throw escape("sdkRoot");
  let sdkPkgVersion: unknown;
  try {
    sdkPkgVersion = (
      JSON.parse(readFileSync(sdkPkgJoin.status === "ok" ? sdkPkgJoin.value : "", "utf8")) as {
        version?: unknown;
      }
    ).version;
  } catch {
    sdkPkgVersion = undefined;
  }
  if (sdkPkgVersion !== CURSOR_SDK_VERSION) {
    throw new CursorSdkAssetsError(
      "sdk_invalid",
      `Cursor SDK package under ${sdkRel} in ${root} is not the exact @cursor/sdk@${CURSOR_SDK_VERSION} original package (found version ${JSON.stringify(
        sdkPkgVersion,
      )}). Rebuild with \`${BUILD_COMMAND}\`; never substitute a repackaged or patched SDK.`,
    );
  }

  return {
    root,
    nodePath,
    runtimeEntryPath,
    authEntryPath,
    sdkVersion: CURSOR_SDK_VERSION,
    nodeVersion: CURSOR_NODE_VERSION,
  };
}

/**
 * Resolve the Cursor SDK runtime assets.
 *
 * @throws {CursorSdkAssetsError} sanitized, actionable typed errors when the
 * assets are missing or incompatible. Never imports the SDK, never uses the
 * network, and never resolves a path from per-agent env.
 */
export function resolveCursorSdkAssets(options: CursorSdkAssetsResolveOptions = {}): CursorSdkAssets {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  const envRoot = env[RAFT_CURSOR_SDK_ASSETS_ENV];
  if (typeof envRoot === "string" && envRoot.trim().length > 0) {
    const root = path.resolve(envRoot.trim());
    if (!existsSync(root)) {
      throw new CursorSdkAssetsError(
        "env_root_invalid",
        `${RAFT_CURSOR_SDK_ASSETS_ENV} points at ${root}, which does not exist. Point it at the asset root (packaged desktop: <resources>/cursor-sdk) or rebuild with \`${BUILD_COMMAND}\`.`,
      );
    }
    return validateAssetRoot(root, platform, arch);
  }

  // Development default: walk up from this module looking for the daemon
  // root's runtime-assets staging directory. Inside an Electron/SEA bundle
  // there is no such ancestor, so packaged hosts must set the env var.
  const target = `${platform}-${arch}`;
  const startPath = fileURLToPath(options.moduleUrl ?? import.meta.url);
  let dir = path.dirname(startPath);
  for (;;) {
    const candidate = path.join(
      dir,
      DEV_ASSETS_DIRNAME,
      "cursor",
      CURSOR_SDK_VERSION,
      target,
    );
    if (existsSync(path.join(candidate, "manifest.json"))) {
      return validateAssetRoot(candidate, platform, arch);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new CursorSdkAssetsError(
    "dev_root_not_found",
    `Cursor SDK assets not found for ${target}. Set ${RAFT_CURSOR_SDK_ASSETS_ENV} to a staged asset root (packaged desktop sets it from resources/cursor-sdk), or build dev assets with \`${BUILD_COMMAND}\`. ${devHint(target)}`,
  );
}


export interface CursorSdkAssetsIntegrityResult {
  ok: boolean;
  root: string;
  sdkVersion: string;
  nodeVersion: string;
  /** Number of manifest entries whose SHA256 matched the bytes on disk. */
  verifiedFiles: number;
  /**
   * Sanitized problem descriptions (relative paths and reasons only — never
   * file contents). Empty iff ok.
   */
  problems: string[];
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Full integrity verification of a staged asset root against its generated
 * SHA256 manifest.
 *
 * ENFORCEMENT POINT (integration review, Assets): a version-only
 * package.json check is not proof the original SDK bytes were loaded. Callers
 * that hand credentials to the hosts (credential lease / host spawn) and the
 * packaging flow MUST pass this check first. It re-runs every structural
 * check of {@link resolveCursorSdkAssets} and then proves, per file, that the
 * bytes on disk still equal the manifest the stager generated — including the
 * staged node binary, both host entries, the SDK package and its whole
 * production closure. Extra files the manifest does not vouch for, and
 * symlinked entries, are problems. Filesystem-only: no SDK import, no
 * network, no secrets read (hashes only).
 */
export function verifyCursorSdkAssetsIntegrity(
  options: CursorSdkAssetsResolveOptions = {},
): CursorSdkAssetsIntegrityResult {
  const assets = resolveCursorSdkAssets(options);
  const manifest = JSON.parse(
    readFileSync(path.join(assets.root, "manifest.json"), "utf8"),
  ) as ManifestShape;
  const problems: string[] = [];

  const rootReal = realPathOrThrow(assets.root);
  const inventory = manifest.files;
  if (inventory === undefined || typeof inventory !== "object" || Array.isArray(inventory) || Object.keys(inventory).length === 0) {
    return {
      ok: false,
      root: assets.root,
      sdkVersion: assets.sdkVersion,
      nodeVersion: assets.nodeVersion,
      verifiedFiles: 0,
      problems: ["manifest has no file integrity inventory (files)"],
    };
  }

  const seenOnDisk = new Set<string>();
  const walkProblems = walkInventory(assets.root, rootReal, seenOnDisk);
  problems.push(...walkProblems);

  let verified = 0;
  for (const [rel, expectedRaw] of Object.entries(inventory)) {
    if (!isConfinedRelativePath(rel)) {
      problems.push(`manifest inventory path escapes asset root: ${rel}`);
      continue;
    }
    const expected = typeof expectedRaw === "string" ? expectedRaw : "";
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      problems.push(`manifest inventory entry for ${rel} is not a sha256 hex digest`);
      continue;
    }
    const onDisk = seenOnDisk.has(rel);
    if (!onDisk) {
      problems.push(`file missing: ${rel}`);
      continue;
    }
    const actual = sha256File(path.join(assets.root, rel));
    if (actual !== expected) {
      problems.push(`hash mismatch: ${rel}`);
      continue;
    }
    verified++;
  }

  // The critical executable/host/package paths must be *covered by the
  // inventory*, not merely present on disk — a manifest that "forgets" to
  // hash the node binary or a host entry must never pass.
  const entries = (manifest.entries ?? {}) as Record<string, unknown>;
  const required = [
    String(entries.nodePath ?? ""),
    String(entries.runtimeEntryPath ?? ""),
    String(entries.authEntryPath ?? ""),
    entries.sdkRoot !== undefined ? `${String(entries.sdkRoot)}/package.json` : "",
  ];
  for (const rel of required) {
    if (rel && !(rel in inventory)) {
      problems.push(`manifest inventory does not cover required entry: ${rel}`);
    }
  }

  for (const rel of seenOnDisk) {
    if (rel !== "manifest.json" && !(rel in inventory)) {
      problems.push(`unmanifested file present: ${rel}`);
    }
  }

  return {
    ok: problems.length === 0,
    root: assets.root,
    sdkVersion: assets.sdkVersion,
    nodeVersion: assets.nodeVersion,
    verifiedFiles: verified,
    problems,
  };
}

/**
 * Walk the staged root collecting every real file (relative, posix-separator
 * keys, .DS_Store ignored — the stager ignores it too). Symlinked entries are
 * reported as problems and not followed, so a symlink swap can neither
 * escape the root nor launder a hash mismatch.
 */
function walkInventory(root: string, rootReal: string, seen: Set<string>): string[] {
  const problems: string[] = [];
  const walk = (dir: string, relPrefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = path.join(root, rel);
      let real: string;
      try {
        if (entry.isSymbolicLink()) {
          problems.push(`symlink in staged assets: ${rel}`);
          continue;
        }
        real = realpathSync(full);
      } catch {
        problems.push(`unresolvable path in staged assets: ${rel}`);
        continue;
      }
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        problems.push(`path escapes asset root: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) seen.add(rel);
    }
  };
  walk(root, "");
  return problems;
}

export interface CursorSdkAssetsProbe {
  available: boolean;
  version?: string;
  diagnostic?: string;
}

/**
 * Non-throwing availability probe for UI/diagnostics. Same filesystem-only
 * checks as {@link resolveCursorSdkAssets}; the diagnostic is the sanitized
 * error summary and never contains secrets.
 */
export function probeCursorSdkAssets(options: CursorSdkAssetsResolveOptions = {}): CursorSdkAssetsProbe {
  try {
    const assets = resolveCursorSdkAssets(options);
    return { available: true, version: assets.sdkVersion };
  } catch (error) {
    if (error instanceof CursorSdkAssetsError) {
      return { available: false, diagnostic: `${error.kind}: ${error.message}` };
    }
    return {
      available: false,
      diagnostic: `unexpected_error: ${
        error instanceof Error ? error.constructor.name : "unknown"
      } while resolving Cursor SDK assets`,
    };
  }
}
