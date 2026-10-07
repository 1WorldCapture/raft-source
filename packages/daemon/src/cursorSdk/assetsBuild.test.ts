import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  CURSOR_SDK_VERSION,
  RAFT_CURSOR_SDK_ASSETS_ENV,
  probeCursorSdkAssets,
  resolveCursorSdkAssets,
} from "./assets.js";

/**
 * End-to-end contract between the asset builder
 * (scripts/build-cursor-sdk-assets.mjs) and the resolver (./assets.ts).
 *
 * The fixture closure is a version-correct MINIMAL stand-in (the builder's
 * --sdk-from-local mode checks package.json versions, not file contents, and
 * the real registry tarballs' sha512 pins are exercised only in networked
 * builds). The Node fixture is a script echoing the pinned version — enough
 * for the builder's --node-from-local version probe and the resolver's
 * structural checks. This proves the whole chain offline: stage → manifest →
 * verify → resolver acceptance, plus tamper detection.
 */

const DAEMON_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILDER = path.join(DAEMON_ROOT, "scripts", "build-cursor-sdk-assets.mjs");

const FIXTURE_CLOSURE = {
  "@cursor/sdk": "1.0.36",
  "@bufbuild/protobuf": "1.10.0",
  "@connectrpc/connect": "1.7.0",
  "@connectrpc/connect-web": "1.7.0",
  "@statsig/js-client": "3.31.0",
  "@statsig/client-core": "3.31.0",
  zod: "3.25.76",
  "@cursor/sdk-darwin-arm64": "1.0.36",
};

function writeFixtureNodeModules(dir: string): string {
  const root = path.join(dir, "fixture-node_modules");
  for (const [name, version] of Object.entries(FIXTURE_CLOSURE)) {
    const pkgDir = path.join(root, ...name.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name, version, main: "index.js" }),
    );
    writeFileSync(path.join(pkgDir, "index.js"), "export {};\n");
  }
  return root;
}

function writeFixtureNodeDist(dir: string): string {
  const root = path.join(dir, "fixture-node", "bin");
  mkdirSync(root, { recursive: true });
  const nodeStub = path.join(root, "node");
  writeFileSync(nodeStub, "#!/bin/sh\necho v24.15.0\n");
  chmodSync(nodeStub, 0o755);
  return path.join(dir, "fixture-node");
}

function runBuilder(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [BUILDER, ...args], {
    cwd: DAEMON_ROOT,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ...env },
  });
}

test("builder stages a root the resolver accepts, and verify catches tampering", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-assets-e2e-"));
  const base = path.join(dir, "assets");
  const sdkSource = writeFixtureNodeModules(dir);
  const nodeSource = writeFixtureNodeDist(dir);
  try {
    // Full stage: sdk (local fixture) + node (local fixture) + hosts (REAL
    // transpiled host sources, @cursor/sdk external) + manifest.
    const staged = runBuilder(
      [
        "--sdk-from-local",
        sdkSource,
        "--node-from-local",
        nodeSource,
        "--target",
        "darwin-arm64",
      ],
      { RAFT_CURSOR_ASSETS_BASE: base },
    );
    assert.equal(
      staged.status,
      0,
      `builder failed:\nstdout: ${staged.stdout}\nstderr: ${staged.stderr}`,
    );

    const root = path.join(base, CURSOR_SDK_VERSION, "darwin-arm64");
    assert.ok(existsSync(path.join(root, "manifest.json")), "manifest.json missing");
    assert.ok(existsSync(path.join(root, "host", "runtimeHost.mjs")), "runtime host missing");
    assert.ok(existsSync(path.join(root, "host", "authHost.mjs")), "auth host missing");
    assert.ok(
      existsSync(path.join(root, "node_modules", "@cursor", "sdk", "package.json")),
      "sdk closure missing",
    );
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.sdkVersion, CURSOR_SDK_VERSION);
    assert.equal(manifest.hosts, "present");
    assert.equal(manifest.provenance.sdk.source, "local-copy");
    assert.equal(manifest.provenance.node.source, "local-dir");
    // The inventory must cover every closure package, both hosts and the node
    // binary — the fixture closure is intentionally minimal, so assert members
    // rather than a size.
    const files = new Set(Object.keys(manifest.files));
    for (const name of Object.keys(FIXTURE_CLOSURE)) {
      assert.ok(
        files.has(path.join("node_modules", ...name.split("/"), "package.json")),
        `manifest missing ${name}/package.json`,
      );
    }
    for (const rel of ["host/runtimeHost.mjs", "host/authHost.mjs", "node/bin/node"]) {
      assert.ok(files.has(rel), `manifest missing ${rel}`);
    }
    // Host entries must reference the SDK externally, never inline it.
    for (const entry of ["runtimeHost.mjs", "authHost.mjs"]) {
      const host = readFileSync(path.join(root, "host", entry), "utf8");
      assert.doesNotMatch(host, /from\s*["']@cursor\/sdk/, `${entry} inlined the SDK`);
    }

    // The resolver (env exact-root path) accepts the builder's output.
    const assets = resolveCursorSdkAssets({
      env: { [RAFT_CURSOR_SDK_ASSETS_ENV]: root },
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(assets.root, root);
    assert.equal(assets.nodePath, path.join(root, "node", "bin", "node"));
    assert.deepEqual(probeCursorSdkAssets({ env: { [RAFT_CURSOR_SDK_ASSETS_ENV]: root } }), {
      available: true,
      version: CURSOR_SDK_VERSION,
    });

    // Clean verify, then tamper detection.
    assert.equal(runBuilder(["--verify", "--target", "darwin-arm64"], { RAFT_CURSOR_ASSETS_BASE: base }).status, 0);
    const victim = path.join(root, "node_modules", "zod", "index.js");
    writeFileSync(victim, "export const tampered = true;\n");
    const tampered = runBuilder(["--verify", "--target", "darwin-arm64"], { RAFT_CURSOR_ASSETS_BASE: base });
    assert.notEqual(tampered.status, 0, "verify must fail after tampering");
    assert.match(tampered.stderr, /integrity mismatch|unmanifested/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("builder refuses a local Node whose version is not the pinned official one", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-assets-badnode-"));
  const base = path.join(dir, "assets");
  const sdkSource = writeFixtureNodeModules(dir);
  const wrongNodeBin = path.join(dir, "wrong-node", "bin");
  mkdirSync(wrongNodeBin, { recursive: true });
  const stub = path.join(wrongNodeBin, "node");
  writeFileSync(stub, "#!/bin/sh\necho v24.12.0\n");
  chmodSync(stub, 0o755);
  try {
    const result = runBuilder(
      ["--only", "node", "--node-from-local", path.join(dir, "wrong-node"), "--target", "darwin-arm64"],
      { RAFT_CURSOR_ASSETS_BASE: base },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /v24\.12\.0.*expected v24\.15\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── integration review (Assets): verify-side hardening ─────────────────────

test("builder --verify refuses manifest inventory paths that escape the root", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-assets-verify-escape-"));
  const base = path.join(dir, "assets");
  try {
    assert.equal(stageFixtureRoot(dir, base).status, 0);
    const root = path.join(base, CURSOR_SDK_VERSION, "darwin-arm64");
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files["../../hostile"] = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const result = runBuilder(["--verify", "--target", "darwin-arm64"], { RAFT_CURSOR_ASSETS_BASE: base });
    assert.notEqual(result.status, 0, "verify must fail on escaping inventory paths");
    assert.match(result.stderr, /manifest inventory path escapes asset root: \.\.\/\.\.\/hostile/);
    // The escaping path must never have been read from outside the root.
    assert.ok(!existsSync(path.join(dir, "hostile")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("builder --verify --require-registry rejects local-copy dev provenance", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cursor-assets-verify-prov-"));
  const base = path.join(dir, "assets");
  try {
    assert.equal(stageFixtureRoot(dir, base).status, 0);
    const result = runBuilder(
      ["--verify", "--require-registry", "--target", "darwin-arm64"],
      { RAFT_CURSOR_ASSETS_BASE: base },
    );
    assert.notEqual(result.status, 0, "release packaging must not accept local-copy provenance");
    assert.match(result.stderr, /--require-registry.*sdk=local-copy.*node=local-dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Stage a complete fixture root (local provenance) into a scratch base. */
function stageFixtureRoot(dir: string, base: string) {
  const sdkSource = writeFixtureNodeModules(dir);
  const nodeSource = writeFixtureNodeDist(dir);
  return runBuilder(
    ["--sdk-from-local", sdkSource, "--node-from-local", nodeSource, "--target", "darwin-arm64"],
    { RAFT_CURSOR_ASSETS_BASE: base },
  );
}
