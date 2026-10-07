import assert from "node:assert/strict";
import { test } from "vitest";
import { parseReclaimArgs } from "./reclaim-deleted-agent-residue.js";

test("reclaimer CLI is dry-run by default and requires DATABASE_URL even for dry-run", () => {
  assert.deepEqual(parseReclaimArgs([], { DATABASE_URL: "postgres://example.invalid/raft" }), {
    mode: "dry-run",
  });
  assert.deepEqual(parseReclaimArgs(["--apply"], { DATABASE_URL: "postgres://example.invalid/raft" }), {
    mode: "apply",
  });
  assert.throws(
    () => parseReclaimArgs([], {}),
    /DATABASE_URL is required/,
    "missing DATABASE_URL must fail before any connection is opened",
  );
  assert.throws(
    () => parseReclaimArgs(["--apply"], {}),
    /DATABASE_URL is required/,
  );
});
