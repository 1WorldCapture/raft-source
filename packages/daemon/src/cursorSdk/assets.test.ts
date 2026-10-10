import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import {
  CURSOR_NODE_VERSION,
  CURSOR_SDK_VERSION,
  CursorSdkAssetsError,
  RAFT_CURSOR_SDK_ASSETS_ENV,
  probeCursorSdkAssets,
  resolveCursorSdkAssets,
  verifyCursorSdkAssetsIntegrity,
} from "./assets.js";

/**
 * Cursor SDK runtime-asset resolver contract (assets worker ownership):
 *  - exact-root env resolution with fail-closed validation (no fallback),
 *  - dev discovery of the staged runtime-assets layout,
 *  - sanitized actionable typed errors for every missing/incompatible shape,
 *  - a probe that never throws,
 *  - and the hard invariant: resolving never imports @cursor/sdk.
 */

const TARGET = "darwin-arm64";

interface RootOptions {
  sdkVersion?: string;
  nodeVersion?: string;
  target?: string;
  hosts?: "present" | "missing";
  omit?: ("node" | "runtime" | "auth" | "sdk")[];
  sdkPackageVersion?: string;
  /** Also generate a real SHA256 files inventory so integrity verification runs. */
  integrity?: boolean;
  /** Overrides for entry paths, to test confinement. */
  entryOverrides?: Partial<{ nodePath: string; runtimeEntryPath: string; authEntryPath: string; sdkRoot: string }>;
}

function writeAssetRoot(root: string, options: RootOptions = {}): void {
  const omit = new Set(options.omit ?? []);
  mkdirSync(path.join(root, "node", "bin"), { recursive: true });
  const nodeBin = path.join(root, "node", "bin", "node");
  writeFileSync(nodeBin, "#!/bin/sh\nexit 0\n");
  chmodSync(nodeBin, 0o755);
  mkdirSync(path.join(root, "host"), { recursive: true });
  writeFileSync(path.join(root, "host", "runtimeHost.mjs"), "export {};\n");
  writeFileSync(path.join(root, "host", "authHost.mjs"), "export {};\n");
  const sdkRoot = path.join(root, "node_modules", "@cursor", "sdk");
  mkdirSync(sdkRoot, { recursive: true });
  writeFileSync(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({ name: "@cursor/sdk", version: options.sdkPackageVersion ?? options.sdkVersion ?? CURSOR_SDK_VERSION }),
  );
  // Benign extra staged file (real Node distributions ship one) so the
  // inventory covers a path the structural resolver does not itself check.
  writeFileSync(path.join(root, "node", "LICENSE"), "official node distribution\n");
  const entries = {
    nodePath: "node/bin/node",
    runtimeEntryPath: "host/runtimeHost.mjs",
    authEntryPath: "host/authHost.mjs",
    sdkRoot: "node_modules/@cursor/sdk",
    ...options.entryOverrides,
  };
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    sdkVersion: options.sdkVersion ?? CURSOR_SDK_VERSION,
    nodeVersion: options.nodeVersion ?? CURSOR_NODE_VERSION,
    target: options.target ?? TARGET,
    hosts: options.hosts ?? "present",
    entries,
  };
  if (options.integrity) {
    manifest.files = inventoryFiles(root);
  }
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (omit.has("node")) rmSync(path.join(root, "node"), { recursive: true, force: true });
  if (omit.has("runtime")) rmSync(path.join(root, "host", "runtimeHost.mjs"));
  if (omit.has("auth")) rmSync(path.join(root, "host", "authHost.mjs"));
  if (omit.has("sdk")) rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
}


function sha256Of(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function inventoryFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name === "manifest.json") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.isFile()) files[rel] = sha256Of(path.join(dir, entry.name));
    }
  };
  walk(root, "");
  return files;
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resolveOpts(root: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { env: { [RAFT_CURSOR_SDK_ASSETS_ENV]: root }, platform: "darwin", arch: "arm64", ...extra };
}

test("exports pin the exact staged versions", () => {
  assert.equal(CURSOR_SDK_VERSION, "1.0.36");
  assert.equal(CURSOR_NODE_VERSION, "24.15.0");
});

test("resolves a valid exact root from the host-owner env", () => {
  const dir = tempDir("cursor-assets-env-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root);
    const assets = resolveCursorSdkAssets(resolveOpts(root) as never);
    assert.equal(assets.root, root);
    assert.equal(assets.nodePath, path.join(root, "node", "bin", "node"));
    assert.equal(assets.runtimeEntryPath, path.join(root, "host", "runtimeHost.mjs"));
    assert.equal(assets.authEntryPath, path.join(root, "host", "authHost.mjs"));
    assert.equal(assets.sdkVersion, CURSOR_SDK_VERSION);
    assert.equal(assets.nodeVersion, CURSOR_NODE_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env root that does not exist fails closed without dev fallback", () => {
  const dir = tempDir("cursor-assets-missing-");
  try {
    // A perfectly valid dev tree exists, but the env var is authoritative:
    // once set, it must not be silently ignored.
    writeAssetRoot(path.join(dir, "daemon", "runtime-assets", "cursor", CURSOR_SDK_VERSION, TARGET));
    const moduleUrl = pathToFileURL(path.join(dir, "daemon", "src", "cursorSdk", "assets.ts"));
    assert.throws(
      () =>
        resolveCursorSdkAssets(
          resolveOpts(path.join(dir, "nope"), { moduleUrl }) as never,
        ),
      (error: unknown) => {
        assert.ok(error instanceof CursorSdkAssetsError);
        assert.equal(error.kind, "env_root_invalid");
        assert.match(error.message, /build:cursor-assets/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env root without a manifest is a typed manifest error", () => {
  const dir = tempDir("cursor-assets-nomanifest-");
  try {
    const root = path.join(dir, "cursor-sdk");
    mkdirSync(root, { recursive: true });
    assert.throws(
      () => resolveCursorSdkAssets(resolveOpts(root) as never),
      (error: unknown) => {
        assert.ok(error instanceof CursorSdkAssetsError);
        assert.equal(error.kind, "manifest_invalid");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sdk/node version mismatch in the manifest is rejected", () => {
  const dir = tempDir("cursor-assets-version-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { sdkVersion: "1.0.35", nodeVersion: "24.14.0" });
    assert.throws(
      () => resolveCursorSdkAssets(resolveOpts(root) as never),
      (error: unknown) => {
        assert.ok(error instanceof CursorSdkAssetsError);
        assert.equal(error.kind, "version_mismatch");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assets staged for another platform target are rejected", () => {
  const dir = tempDir("cursor-assets-target-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { target: "linux-x64" });
    assert.throws(
      () => resolveCursorSdkAssets(resolveOpts(root) as never),
      (error: unknown) => {
        assert.ok(error instanceof CursorSdkAssetsError);
        assert.equal(error.kind, "target_mismatch");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing staged Node binary is a typed error", () => {
  const dir = tempDir("cursor-assets-node-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { omit: ["node"] });
    assert.throws(
      () => resolveCursorSdkAssets(resolveOpts(root) as never),
      (error: unknown) => {
        assert.ok(error instanceof CursorSdkAssetsError);
        assert.equal(error.kind, "missing_node");
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing host entries are typed errors", () => {
  const dir = tempDir("cursor-assets-hosts-");
  try {
    const rootNoRuntime = path.join(dir, "no-runtime");
    writeAssetRoot(rootNoRuntime, { omit: ["runtime"] });
    assert.equal(
      captureKind(() => resolveCursorSdkAssets(resolveOpts(rootNoRuntime) as never)),
      "missing_entry",
    );
    const rootHostsMissing = path.join(dir, "hosts-missing");
    writeAssetRoot(rootHostsMissing, { hosts: "missing" });
    assert.equal(
      captureKind(() => resolveCursorSdkAssets(resolveOpts(rootHostsMissing) as never)),
      "missing_entry",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an SDK package that is not the exact pinned version is rejected", () => {
  const dir = tempDir("cursor-assets-sdkversion-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { sdkPackageVersion: "1.0.37" });
    assert.equal(
      captureKind(() => resolveCursorSdkAssets(resolveOpts(root) as never)),
      "sdk_invalid",
    );
    const rootNoSdk = path.join(dir, "no-sdk");
    writeAssetRoot(rootNoSdk, { omit: ["sdk"] });
    assert.equal(
      captureKind(() => resolveCursorSdkAssets(resolveOpts(rootNoSdk) as never)),
      "sdk_invalid",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev discovery finds the staged runtime-assets tree from the daemon module location", () => {
  const dir = tempDir("cursor-assets-dev-");
  try {
    const daemonRoot = path.join(dir, "daemon");
    const root = path.join(daemonRoot, "runtime-assets", "cursor", CURSOR_SDK_VERSION, TARGET);
    writeAssetRoot(root);
    const moduleUrl = pathToFileURL(path.join(daemonRoot, "src", "cursorSdk", "assets.ts"));
    const assets = resolveCursorSdkAssets({
      env: {},
      moduleUrl,
      platform: "darwin",
      arch: "arm64",
    } as never);
    assert.equal(assets.root, root);

    // Same result when the daemon runs from its dist/ chunk layout.
    const moduleUrlDist = pathToFileURL(path.join(daemonRoot, "dist", "assets-ABC123.js"));
    assert.equal(
      resolveCursorSdkAssets({ env: {}, moduleUrl: moduleUrlDist, platform: "darwin", arch: "arm64" } as never).root,
      root,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev discovery failure is a typed, actionable error", () => {
  const dir = tempDir("cursor-assets-nodev-");
  try {
    const moduleUrl = pathToFileURL(path.join(dir, "somewhere", "assets.ts"));
    assert.throws(
      () =>
        resolveCursorSdkAssets({
          // SLOCK_HOME pinned to the empty fixture dir keeps the standalone
          // home fallback quiet on machines that really have ~/.slock.
          env: { SLOCK_HOME: dir },
          moduleUrl,
          platform: "darwin",
          arch: "arm64",
        } as never),
      (error: unknown) => {
        assert.ok(error instanceof CursorSdkAssetsError);
        assert.equal(error.kind, "dev_root_not_found");
        assert.match(error.message, /runtime-assets\/cursor\/1\.0\.36\/darwin-arm64/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blank env value is ignored in favor of dev discovery", () => {
  const dir = tempDir("cursor-assets-blank-");
  try {
    const daemonRoot = path.join(dir, "daemon");
    const root = path.join(daemonRoot, "runtime-assets", "cursor", CURSOR_SDK_VERSION, TARGET);
    writeAssetRoot(root);
    const moduleUrl = pathToFileURL(path.join(daemonRoot, "src", "cursorSdk", "assets.ts"));
    const assets = resolveCursorSdkAssets({
      env: { [RAFT_CURSOR_SDK_ASSETS_ENV]: "   " },
      moduleUrl,
      platform: "darwin",
      arch: "arm64",
    } as never);
    assert.equal(assets.root, root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe reports availability without throwing", () => {
  const dir = tempDir("cursor-assets-probe-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root);
    const ok = probeCursorSdkAssets(resolveOpts(root) as never);
    assert.deepEqual(ok, { available: true, version: CURSOR_SDK_VERSION });

    const bad = probeCursorSdkAssets(resolveOpts(path.join(dir, "missing")));
    assert.equal(bad.available, false);
    assert.match(bad.diagnostic ?? "", /^env_root_invalid: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The resolver is filesystem-only: importing it and resolving/probing must
 * never load @cursor/sdk (the SDK runs only in the external staged-Node hosts).
 * Mirrors the heavy-SDK guard in lazySdkLoading.test.ts.
 */
test("resolving and probing assets never imports @cursor/sdk", () => {
  const daemonRoot = fileURLToPath(new URL("..", import.meta.url));
  const assetsUrl = new URL("./assets.ts", import.meta.url).href;
  const dir = tempDir("cursor-assets-noimport-");
  try {
    const record = path.join(dir, "resolved.txt");
    const hooks = path.join(dir, "hooks.mjs");
    const register = path.join(dir, "register.mjs");
    const probe = path.join(dir, "probe.mjs");
    writeFileSync(
      hooks,
      `
import { appendFileSync } from "node:fs";
const WATCHED = ["@cursor/sdk", "@cursor/sdk-darwin-arm64"];
export async function resolve(specifier, context, next) {
  if (WATCHED.some((pkg) => specifier === pkg || specifier.startsWith(pkg + "/"))) {
    appendFileSync(${JSON.stringify(record)}, specifier + "\\n");
  }
  return next(specifier, context);
}
`,
    );
    writeFileSync(
      register,
      `import { register } from "node:module"; register(${JSON.stringify(new URL(`file://${hooks}`).href)});`,
    );
    writeFileSync(
      probe,
      `
const mod = await import(${JSON.stringify(assetsUrl)});
try { mod.resolveCursorSdkAssets({ env: { RAFT_CURSOR_SDK_ASSETS: "/nonexistent-cursor-assets" } }); } catch {}
mod.probeCursorSdkAssets({});
console.log("probe-done");
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--import", register, probe],
      { cwd: daemonRoot, encoding: "utf8", timeout: 60_000, env: process.env },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.ok(result.stdout.includes("probe-done"), `stdout: ${result.stdout}`);
    if (existsSync(record)) {
      assert.fail(`SDK was imported during resolution:\n${readFileSync(record, "utf8")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureKind(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CursorSdkAssetsError, `expected CursorSdkAssetsError, got ${String(error)}`);
    return error.kind;
  }
  throw new Error("expected resolveCursorSdkAssets to throw");
}


// ─── integration review (Assets): manifest paths confined to the asset root ──

test("manifest entry paths with .. segments are rejected as path_escape", () => {
  const dir = tempDir("cursor-assets-escape-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { entryOverrides: { nodePath: "../../outside/node" } });
    assert.equal(captureKind(() => resolveCursorSdkAssets(resolveOpts(root) as never)), "path_escape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("absolute manifest entry paths are rejected as path_escape", () => {
  const dir = tempDir("cursor-assets-abs-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, {
      entryOverrides: { runtimeEntryPath: "/etc/passwd" },
    });
    assert.equal(captureKind(() => resolveCursorSdkAssets(resolveOpts(root) as never)), "path_escape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked host entry pointing outside the root is rejected as path_escape", () => {
  const dir = tempDir("cursor-assets-symlink-");
  try {
    const outside = path.join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "evil.mjs"), "export const evil = true;\n");
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root);
    rmSync(path.join(root, "host", "authHost.mjs"));
    symlinkSync(path.join(outside, "evil.mjs"), path.join(root, "host", "authHost.mjs"));
    assert.equal(captureKind(() => resolveCursorSdkAssets(resolveOpts(root) as never)), "path_escape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── integration review (Assets): integrity enforced against the generated manifest ──

test("verifyCursorSdkAssetsIntegrity passes a pristine root and counts verified files", () => {
  const dir = tempDir("cursor-assets-integ-ok-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { integrity: true });
    const result = verifyCursorSdkAssetsIntegrity(resolveOpts(root) as never);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.problems, []);
    assert.ok(result.verifiedFiles >= 5, `expected the fixture files hashed, got ${result.verifiedFiles}`);
    assert.equal(result.sdkVersion, CURSOR_SDK_VERSION);
    assert.equal(result.nodeVersion, CURSOR_NODE_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCursorSdkAssetsIntegrity reports a modified file as a hash mismatch", () => {
  const dir = tempDir("cursor-assets-integ-tamper-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { integrity: true });
    writeFileSync(path.join(root, "host", "runtimeHost.mjs"), "export const tampered = true;\n");
    const result = verifyCursorSdkAssetsIntegrity(resolveOpts(root) as never);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p === "hash mismatch: host/runtimeHost.mjs"), JSON.stringify(result.problems));
    // Problems stay sanitized: relative path + reason only, no file contents.
    for (const problem of result.problems) assert.doesNotMatch(problem, /tampered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCursorSdkAssetsIntegrity reports files the manifest does not vouch for", () => {
  const dir = tempDir("cursor-assets-integ-extra-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { integrity: true });
    writeFileSync(path.join(root, "node_modules", "@cursor", "sdk", "implant.js"), "export {};\n");
    const result = verifyCursorSdkAssetsIntegrity(resolveOpts(root) as never);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p === "unmanifested file present: node_modules/@cursor/sdk/implant.js"),
      JSON.stringify(result.problems),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCursorSdkAssetsIntegrity fails a manifest that skips hashing a required entry", () => {
  const dir = tempDir("cursor-assets-integ-skip-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { integrity: true });
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.files["node/bin/node"];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = verifyCursorSdkAssetsIntegrity(resolveOpts(root) as never);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p === "manifest inventory does not cover required entry: node/bin/node"),
      JSON.stringify(result.problems),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCursorSdkAssetsIntegrity rejects symlinks inside the staged tree", () => {
  const dir = tempDir("cursor-assets-integ-symlink-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { integrity: true });
    const target = path.join(dir, "elsewhere.txt");
    writeFileSync(target, "outside\n");
    symlinkSync(target, path.join(root, "node_modules", "@cursor", "sdk", "escape.txt"));
    const result = verifyCursorSdkAssetsIntegrity(resolveOpts(root) as never);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p === "symlink in staged assets: node_modules/@cursor/sdk/escape.txt"),
      JSON.stringify(result.problems),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCursorSdkAssetsIntegrity refuses inventory keys that escape the root", () => {
  const dir = tempDir("cursor-assets-integ-key-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { integrity: true });
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files["../../hostile"] = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = verifyCursorSdkAssetsIntegrity(resolveOpts(root) as never);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p === "manifest inventory path escapes asset root: ../../hostile"),
      JSON.stringify(result.problems),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyCursorSdkAssetsIntegrity reports a missing staged file", () => {
  const dir = tempDir("cursor-assets-integ-missing-");
  try {
    const root = path.join(dir, "cursor-sdk");
    writeAssetRoot(root, { integrity: true });
    rmSync(path.join(root, "node", "LICENSE"));
    const result = verifyCursorSdkAssetsIntegrity(resolveOpts(root) as never);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((p) => p === "file missing: node/LICENSE"),
      JSON.stringify(result.problems),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone fallback: <raft home>/runtime/cursor-sdk resolves when env is unset", () => {
  const dir = tempDir("cursor-assets-home-");
  try {
    const home = path.join(dir, "home");
    const root = path.join(home, "runtime", "cursor-sdk");
    writeAssetRoot(root);
    // moduleUrl in a tree with NO dev runtime-assets → walk-up fails → home.
    const moduleUrl = pathToFileURL(path.join(dir, "somewhere", "assets.ts"));
    const assets = resolveCursorSdkAssets({
      env: { SLOCK_HOME: home },
      moduleUrl,
      platform: "darwin",
      arch: "arm64",
    } as never);
    assert.equal(assets.root, root);

    // RAFT_HOME wins over SLOCK_HOME in the fallback, matching raftHome.ts.
    const otherHome = path.join(dir, "other-home");
    const otherRoot = path.join(otherHome, "runtime", "cursor-sdk");
    writeAssetRoot(otherRoot);
    assert.equal(
      resolveCursorSdkAssets({
        env: { RAFT_HOME: otherHome, SLOCK_HOME: home },
        moduleUrl,
        platform: "darwin",
        arch: "arm64",
      } as never).root,
      otherRoot,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dev discovery stays authoritative over the standalone home fallback", () => {
  const dir = tempDir("cursor-assets-devwins-");
  try {
    const home = path.join(dir, "home");
    writeAssetRoot(path.join(home, "runtime", "cursor-sdk"));
    const daemonRoot = path.join(dir, "daemon");
    const devRoot = path.join(daemonRoot, "runtime-assets", "cursor", CURSOR_SDK_VERSION, TARGET);
    writeAssetRoot(devRoot);
    const moduleUrl = pathToFileURL(path.join(daemonRoot, "src", "cursorSdk", "assets.ts"));
    assert.equal(
      resolveCursorSdkAssets({
        env: { SLOCK_HOME: home },
        moduleUrl,
        platform: "darwin",
        arch: "arm64",
      } as never).root,
      devRoot,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env root beats the standalone home fallback", () => {
  const dir = tempDir("cursor-assets-envwins-");
  try {
    const home = path.join(dir, "home");
    writeAssetRoot(path.join(home, "runtime", "cursor-sdk"));
    const envRoot = path.join(dir, "env-root");
    writeAssetRoot(envRoot);
    assert.equal(
      resolveCursorSdkAssets({
        env: { [RAFT_CURSOR_SDK_ASSETS_ENV]: envRoot, SLOCK_HOME: home },
        platform: "darwin",
        arch: "arm64",
      } as never).root,
      envRoot,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
