// Run: node --test scripts/desktopTargets.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { resolveDesktopTargets } from "./desktopTargets.mjs";

test("defaults: arm64 only, dmg+zip, arm64-only build script", () => {
  const t = resolveDesktopTargets({});
  assert.deepEqual(t.arches, ["arm64"]);
  assert.deepEqual(t.formats, ["dmg", "zip"]);
  assert.equal(t.script, "dist:mac:arm64");
  assert.deepEqual(t.builderArgs, ["--mac", "dmg", "zip", "--arm64"]);
});

test("formats=zip builds and ships only the zip", () => {
  const t = resolveDesktopTargets({ formats: "zip" });
  assert.deepEqual(t.formats, ["zip"]);
  assert.deepEqual(t.builderArgs, ["--mac", "zip", "--arm64"]);
});

test("format order is normalized and whitespace tolerated", () => {
  assert.deepEqual(resolveDesktopTargets({ formats: " zip , dmg " }).formats, ["dmg", "zip"]);
});

test("arch=all is the legacy dual-arch dmg+zip build", () => {
  const t = resolveDesktopTargets({ arch: "all", formats: "dmg,zip" });
  assert.deepEqual(t.arches, ["arm64", "x64"]);
  assert.equal(t.script, "dist:mac");
  assert.deepEqual(t.builderArgs, []);
  assert.throws(() => resolveDesktopTargets({ arch: "all", formats: "zip" }), /legacy dmg\+zip/);
});

test("rejects unknown arch and formats", () => {
  assert.throws(() => resolveDesktopTargets({ arch: "x64" }), /--desktop-arch must be one of/);
  assert.throws(() => resolveDesktopTargets({ formats: "pkg" }), /--desktop-formats must be/);
  assert.throws(() => resolveDesktopTargets({ formats: "" }), /--desktop-formats must be/);
});
