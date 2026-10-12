import assert from "node:assert/strict";
import { test } from "vitest";

import { readComputerProvenance, UNKNOWN_COMMIT } from "./version.js";

const FULL = "46b8988811aa22bb33cc44dd55ee66ff778899aabb";
const SHORT = FULL.slice(0, 12);

test("reports the baked commit when the build stamped one", () => {
  assert.deepEqual(readComputerProvenance(FULL, SHORT), { sha: FULL, short: SHORT, known: true });
});

test("derives the short form when only the full sha is baked", () => {
  const p = readComputerProvenance(FULL, undefined);
  assert.equal(p.short, SHORT);
  assert.equal(p.known, true);
});

test("falls back to an explicit unknown marker when nothing is baked", () => {
  // This is the case that bit us: a source-run bundle has no baked identifier.
  assert.deepEqual(readComputerProvenance(undefined, undefined), {
    sha: UNKNOWN_COMMIT,
    short: UNKNOWN_COMMIT,
    known: false,
  });
});

test("an identifier baked as unknown stays unknown", () => {
  const p = readComputerProvenance(UNKNOWN_COMMIT, UNKNOWN_COMMIT);
  assert.equal(p.known, false);
  assert.equal(p.sha, UNKNOWN_COMMIT);
});

test("a blank baked value is treated as absent", () => {
  assert.equal(readComputerProvenance("  ", " ").known, false);
});