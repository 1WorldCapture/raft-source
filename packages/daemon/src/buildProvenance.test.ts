import assert from "node:assert/strict";
import { test } from "vitest";

import { formatCommitShort, readDaemonProvenance, UNKNOWN_COMMIT } from "./buildProvenance.js";

const FULL = "d85eb3371234567890abcdef1234567890abcdef";
const SHORT = FULL.slice(0, 12);

test("reports the baked commit when the build stamped one", () => {
  const p = readDaemonProvenance(FULL, SHORT);
  assert.deepEqual(p, { sha: FULL, short: SHORT, known: true });
});

test("derives the short form from the full sha when only the full form is baked", () => {
  const p = readDaemonProvenance(FULL, undefined);
  assert.equal(p.short, SHORT);
  assert.equal(p.known, true);
});

test("falls back to an explicit unknown marker when nothing is baked (source runs)", () => {
  const p = readDaemonProvenance(undefined, undefined);
  assert.deepEqual(p, { sha: UNKNOWN_COMMIT, short: UNKNOWN_COMMIT, known: false });
});

test("an identifier baked as unknown stays unknown rather than becoming a sha", () => {
  const p = readDaemonProvenance(UNKNOWN_COMMIT, UNKNOWN_COMMIT);
  assert.equal(p.known, false);
  assert.equal(formatCommitShort(p), UNKNOWN_COMMIT);
});

test("a blank baked value is treated as absent, not as provenance", () => {
  const p = readDaemonProvenance("   ", "");
  assert.equal(p.known, false);
  assert.equal(p.sha, UNKNOWN_COMMIT);
});

test("formatCommitShort returns the display form", () => {
  assert.equal(formatCommitShort(readDaemonProvenance(FULL, SHORT)), SHORT);
});