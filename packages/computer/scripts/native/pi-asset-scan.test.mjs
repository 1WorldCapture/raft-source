import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";

import {
  PI_ASSET_EXTENSIONS,
  SIDECAR_HANDLED,
  scanPiRuntimeAssets,
} from "./pi-asset-scan.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const daemonPiDir = join(repoRoot, "packages/daemon/node_modules/@earendil-works/pi-coding-agent");

/** Packages whose unhandled assets are a KNOWN, accepted state of the tree.
 *  The scan warns on them at build time (correct behavior), but the contract
 *  test allows ONLY these — any OTHER package shipping unlisted assets fails
 *  the test so the change is seen at PR time, not at first runtime use.
 *  When pi drops one of these, remove the entry; when pi adds one, decide:
 *  sidecar it (build.mjs + SIDECAR_HANDLED) or accept and list it here. */
const KNOWN_UNHANDLED_PACKAGES = [
  // Platform prebuilds for pi's TERMINAL rendering (win32-console-mode.node,
  // darwin-modifiers.node), present since pi 0.8x. The daemon embeds pi as an
  // SDK (headless sessions) and never mounts the TUI, so these never load;
  // the SEA has never shipped them. Accepted as-is.
  "@earendil-works/pi-tui",
  // quickjs-wasi ships quickjs.wasm (637KB) + extensions/*.so for pi's
  // codemode VM. Loaded at runtime via createRequire().resolve — NOT embedded
  // by the SEA — but codemode is a built-in pi extension mounted only by pi's
  // own CLI entry (main.js); the daemon embeds pi as an SDK and never
  // registers it, so the loader is unreachable in daemon/SEA usage today.
  // Byte-verified absent from the SEA binary (PR review on #319, 2026-10-11).
  "quickjs-wasi",
];

/** Fake dependency tree for the pure-logic tests:
 *   pi → { photon-like (whitelisted), vm-like (wasm+so), js-only }
 *   vm-like → js-only (shared dep, must be visited once)
 *   pi → cyclic-dep → pi (cycle guard)
 *   pi devDependency ignored; missing-optional cannot resolve.
 */
function fakeDeps() {
  const pkgs = new Map([
    ["/pkgs/pi", { name: "pi", dir: "/pkgs/pi", dependencies: { "photon-like": "1", "vm-like": "1", "js-only": "1", "cyclic-dep": "1", "missing-optional": "1" }, devDependencies: { "dev-asset": "1" } }],
    ["/pkgs/photon-like", { name: "photon-like", dir: "/pkgs/photon-like", dependencies: {} }],
    ["/pkgs/vm-like", { name: "vm-like", dir: "/pkgs/vm-like", dependencies: { "js-only": "1" } }],
    ["/pkgs/js-only", { name: "js-only", dir: "/pkgs/js-only", dependencies: {} }],
    ["/pkgs/cyclic-dep", { name: "cyclic-dep", dir: "/pkgs/cyclic-dep", dependencies: { pi: "1" } }],
  ]);
  const assets = new Map([
    ["/pkgs/photon-like", ["photon_rs_bg.wasm", "index.js"]],
    // Whitelist match exempts the wasm; the extra .node is still unhandled.
    ["/pkgs/vm-like", ["quickjs.wasm", "extensions/url/url.so", "index.js"]],
    ["/pkgs/js-only", ["index.js"]],
  ]);
  const identity = { realpath: (p) => p };
  return {
    ...identity,
    readPackageJson: (dir) => pkgs.get(dir) ?? null,
    resolveDependencyDir: (fromDir, name) => {
      if (name === "missing-optional") return null;
      // devDependencies are never resolved in a real runtime closure either.
      if (name === "dev-asset") return null;
      const pkg = [...pkgs.values()].find((p) => p.name === name);
      return pkg ? pkg.dir : null;
    },
    listAssets: (dir) => assets.get(dir) ?? [],
  };
}

test("scan walks the runtime closure, resolves cycles, and warns on every asset-bearing package", () => {
  const result = scanPiRuntimeAssets("/pkgs/pi", fakeDeps());
  assert.equal(result.packages, 5);
  assert.deepEqual(result.unresolved, ["missing-optional (from pi)"]);
  // Neither fake package matches the real whitelist key, so all their assets
  // surface — exactly how an unlisted dependency behaves in a real build.
  assert.deepEqual(result.warnings.map((w) => w.package).sort(), ["photon-like", "vm-like"]);
  const vm = result.warnings.find((w) => w.package === "vm-like");
  assert.deepEqual(vm.assets, ["extensions/url/url.so", "quickjs.wasm"]);
});

test("scan: whitelisted assets are exempt per FILE — extra assets still warn", () => {
  // Real whitelist key, fake tree: the sidecar'd wasm is exempt, a second
  // asset in the same package is not (a new asset in photon-node must not
  // silently ride the existing whitelist entry).
  const deps = fakeDeps();
  deps.readPackageJson = (dir) =>
    dir === "/pkgs/pi"
      ? { name: "pi", dir, dependencies: { "@silvia-odwyer/photon-node": "1" } }
      : dir === "/pkgs/photon-like"
        ? { name: "@silvia-odwyer/photon-node", dir, dependencies: {} }
        : null;
  deps.resolveDependencyDir = (_fromDir, name) =>
    name === "@silvia-odwyer/photon-node" ? "/pkgs/photon-like" : null;
  deps.listAssets = (dir) =>
    dir === "/pkgs/photon-like" ? ["photon_rs_bg.wasm", "photon_extra.node"] : [];
  const result = scanPiRuntimeAssets("/pkgs/pi", deps);
  assert.deepEqual(result.warnings, [
    { package: "@silvia-odwyer/photon-node", packageDir: "/pkgs/photon-like", assets: ["photon_extra.node"] },
  ]);
});

test("asset extensions: sidecar-class only", () => {
  assert.equal(PI_ASSET_EXTENSIONS.has(".wasm"), true);
  assert.equal(PI_ASSET_EXTENSIONS.has(".so"), true);
  assert.equal(PI_ASSET_EXTENSIONS.has(".node"), true);
  assert.equal(PI_ASSET_EXTENSIONS.has(".js"), false);
});

test("scan: an absent pi install yields an empty result, never a throw", () => {
  const result = scanPiRuntimeAssets("/definitely/not/installed");
  assert.deepEqual(result, { packages: 0, unresolved: [], warnings: [] });
});

test("contract: the build script wires the warning rail into the SEA pipeline", async () => {
  const source = await readFile(join(repoRoot, "packages/computer/scripts/native/build.mjs"), "utf8");
  assert.match(source, /import \{ warnPiAssetGaps \} from "\.\/pi-asset-scan\.mjs"/);
  assert.match(source, /warnPiAssetGaps\(DAEMON_ROOT\)/);
  assert.match(source, /copyPhotonWasmSidecar\(outDir\)/);
});

test.skipIf(!existsSync(daemonPiDir))("contract: the real daemon pi tree — photon exempt, no unknown asset packages", () => {
  const result = scanPiRuntimeAssets(realpathSync(daemonPiDir));
  assert.ok(result.packages > 10, `expected a real dependency closure, visited ${result.packages}`);
  // 1) The Photon sidecar contract holds: its wasm must never appear as a gap.
  const photon = result.warnings.find((w) => w.package === "@silvia-odwyer/photon-node");
  assert.equal(
    photon?.assets.includes("photon_rs_bg.wasm") ?? false,
    false,
    "photon_rs_bg.wasm lost its sidecar whitelist entry",
  );
  // 2) Sentinel: only KNOWN packages may ship unhandled assets. A NEW package
  //    here means pi (or a transitive dep) added a runtime asset — sidecar it
  //    or add it to KNOWN_UNHANDLED_PACKAGES with a reachability note.
  const unknown = result.warnings
    .map((w) => w.package)
    .filter((name) => !KNOWN_UNHANDLED_PACKAGES.includes(name));
  assert.deepEqual(
    unknown,
    [],
    `pi runtime closure grew asset-bearing packages without sidecar handling: ${unknown.join(", ")}`,
  );
});
