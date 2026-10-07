import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CURSOR_SDK_RESOURCES_SUBPATH, resolveBundledCursorSdkAssets } from "./cursorSdkAssets.ts";

// Cursor SDK asset wiring (assets worker ownership):
//  - packaged build → exact <resources>/cursor-sdk root (manifest-gated),
//  - packaged build without assets → missing (caller warns, runtime degrades),
//  - dev build → null (daemon discovers the dev runtime-assets tree itself),
//  - electron-builder must ship the staged per-arch assets to that subpath.

test("packaged build resolves the manifest-gated resources root", () => {
  const resolved = resolveBundledCursorSdkAssets({
    isPackaged: true,
    resourcesPath: "/Applications/Raft Desktop.app/Contents/Resources",
    exists: (p) => p.endsWith("manifest.json"),
  });
  assert.deepEqual(resolved, {
    root: `/Applications/Raft Desktop.app/Contents/Resources/${CURSOR_SDK_RESOURCES_SUBPATH}`,
    missing: false,
  });
});

test("packaged build without bundled assets reports missing instead of a bogus root", () => {
  const resolved = resolveBundledCursorSdkAssets({
    isPackaged: true,
    resourcesPath: "/Applications/Raft Desktop.app/Contents/Resources",
    exists: () => false,
  });
  assert.deepEqual(resolved, { root: null, missing: true });
});

test("dev build leaves the env unset for daemon-side dev discovery", () => {
  const resolved = resolveBundledCursorSdkAssets({
    isPackaged: false,
    resourcesPath: "/whatever",
    exists: () => true,
  });
  assert.deepEqual(resolved, { root: null, missing: false });
});

test("electron-builder ships the staged cursor assets at the expected subpath", () => {
  // Textual check on the build config: the mapping must point at the staged
  // per-arch asset dir (macros in `from`/`to` are expanded by electron-builder
  // per packaging pass) so the resolver's <resources>/cursor-sdk root holds.
  const here = new URL(".", import.meta.url);
  {
    const yml = readFileSync(new URL("../../electron-builder.yml", here), "utf8");
    const mapping = /from:\s*(\S*cursor[^\s]*)\s*\n\s*to:\s*(\S*cursor-sdk\S*)/.exec(yml);
    assert.ok(mapping, "electron-builder.yml lost its cursor-sdk extraResources mapping");
    assert.match(mapping[1], /runtime-assets\/cursor\/\d+\.\d+\.\d+\/darwin-\$\{arch\}/);
    assert.equal(mapping[2], "cursor-sdk");
  }
  {
    // The release overlay inherits extraResources via `extends`; an explicit
    // mapping there would drift from the base config instead of overriding it.
    const release = readFileSync(new URL("../../electron-builder.release.yml", here), "utf8");
    const mapping = /from:\s*\S*cursor[^\s]*\s*\n\s*to:\s*\S*cursor-sdk\S*/.exec(release);
    assert.ok(
      !mapping || /runtime-assets\/cursor\/\d+\.\d+\.\d+\/darwin-\$\{arch\}/.test(mapping[0]),
      "electron-builder.release.yml cursor-sdk mapping drifted from the staged per-arch layout",
    );
    if (!mapping) assert.match(release, /extends:\s*\.\/electron-builder\.yml/);
  }
});

test("linux electron-builder config ships the linux cursor assets at the same subpath and SDK version", () => {
  const here = new URL(".", import.meta.url);
  const pick = (yml: string) => /from:\s*(\S*cursor[^\s]*)\s*\n\s*to:\s*(\S*cursor-sdk\S*)/.exec(yml);
  const mac = pick(readFileSync(new URL("../../electron-builder.yml", here), "utf8"));
  const linux = pick(readFileSync(new URL("../../electron-builder.linux.yml", here), "utf8"));
  assert.ok(mac && linux, "cursor-sdk extraResources mapping missing");
  assert.match(linux[1], /runtime-assets\/cursor\/\d+\.\d+\.\d+\/linux-\$\{arch\}/);
  assert.equal(linux[2], "cursor-sdk");
  // The pinned SDK version segment must not drift between the mac and linux configs.
  const version = (p: string) => /cursor\/(\d+\.\d+\.\d+)\//.exec(p)?.[1];
  assert.equal(version(linux[1]), version(mac[1]));
});
