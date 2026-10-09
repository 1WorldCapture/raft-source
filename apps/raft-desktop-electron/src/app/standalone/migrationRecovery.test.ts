import assert from "node:assert/strict";
import test from "node:test";
import { findInterruptedMigration, RECOVERY_WINDOW_MS, type MigrationResultSummary } from "./migrationRecovery.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const EMBEDDED = "/Users/u/app/computer-slock-raft";
const success = (over: Partial<MigrationResultSummary> = {}): MigrationResultSummary => ({
  result: "success", from: EMBEDDED, to: "/Users/u/.slock", finishedAt: "2026-10-09T11:50:00Z", ...over,
});

function run(opts: { hostMode?: { mode: "embedded" } | { mode: "standalone"; home: string }; results: Record<string, MigrationResultSummary | null>; toExists?: boolean }) {
  return findInterruptedMigration({
    hostMode: opts.hostMode ?? { mode: "embedded" },
    embeddedHome: EMBEDDED,
    otherHomes: ["/Users/u/.slock"],
    now: () => NOW,
    readResult: async (home) => opts.results[home] ?? null,
    canonical: async (p) => p,
    isDirectory: async () => opts.toExists ?? true,
  });
}

test("embedded launch + a recent success whose from is this app's home: finish the switch to the new home", async () => {
  assert.deepEqual(await run({ results: { "/Users/u/.slock": success() } }), { to: "/Users/u/.slock" });
});

test("in-place success (from == to == the embedded home) is recognised too, from the embedded home's result file", async () => {
  const same = "/Users/u/.slock";
  const r = await findInterruptedMigration({
    hostMode: { mode: "embedded" }, embeddedHome: same, otherHomes: [], now: () => NOW,
    readResult: async () => success({ from: same, to: same }), canonical: async (p) => p, isDirectory: async () => true,
  });
  assert.deepEqual(r, { to: same });
});

test("already standalone: nothing to recover", async () => {
  assert.equal(await run({ hostMode: { mode: "standalone", home: "/Users/u/.slock" }, results: { "/Users/u/.slock": success() } }), null);
});

test("only a success counts: rolled back / failed / no file", async () => {
  assert.equal(await run({ results: { "/Users/u/.slock": success({ result: "rolled_back" }) } }), null);
  assert.equal(await run({ results: { "/Users/u/.slock": success({ result: "failed" }) } }), null);
  assert.equal(await run({ results: {} }), null);
});

test("an old or future-dated result is ignored (a deliberate later rollback must not be undone)", async () => {
  const old = new Date(NOW - RECOVERY_WINDOW_MS - 1000).toISOString();
  assert.equal(await run({ results: { "/Users/u/.slock": success({ finishedAt: old }) } }), null);
  assert.equal(await run({ results: { "/Users/u/.slock": success({ finishedAt: new Date(NOW + 3600_000).toISOString() }) } }), null);
  assert.equal(await run({ results: { "/Users/u/.slock": success({ finishedAt: null }) } }), null);
});

test("a result about some other home is not ours", async () => {
  assert.equal(await run({ results: { "/Users/u/.slock": success({ from: "/somewhere/else", to: "/Users/u/.slock" }) } }), null);
});

test("the new home must exist as a directory", async () => {
  assert.equal(await run({ results: { "/Users/u/.slock": success() }, toExists: false }), null);
});
