import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMPUTER_HOST_KIND, normalizeComputerHostKind } from "./computerHostKind.js";

test("normalizeComputerHostKind keeps known host kinds", () => {
  assert.equal(normalizeComputerHostKind("desktop_app"), "desktop_app");
  assert.equal(normalizeComputerHostKind("standalone"), "standalone");
});

test("normalizeComputerHostKind treats missing or unknown values as standalone", () => {
  assert.equal(DEFAULT_COMPUTER_HOST_KIND, "standalone");
  for (const value of [undefined, null, "", "DESKTOP_APP", "mobile", 1, {}, ["desktop_app"]]) {
    assert.equal(normalizeComputerHostKind(value), "standalone");
  }
});
