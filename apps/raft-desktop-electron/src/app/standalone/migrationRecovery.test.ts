import assert from "node:assert/strict";
import test from "node:test";
import { isMigrationProcess, findInterruptedMigration, findMigratedAwayHome, findRunningMigration, waitForRunningMigration, type InProgressMarker, type MigrationResultSummary } from "./migrationRecovery.ts";

const EMBEDDED = "/Users/u/app/computer-slock-raft";
const success = (over: Partial<MigrationResultSummary> = {}): MigrationResultSummary => ({
  result: "success", from: EMBEDDED, to: "/Users/u/.slock", finishedAt: "2026-10-09T11:50:00Z", ...over,
});

function run(opts: { hostMode?: { mode: "embedded" } | { mode: "standalone"; home: string }; results: Record<string, MigrationResultSummary | null>; toExists?: boolean }) {
  return findInterruptedMigration({
    hostMode: opts.hostMode ?? { mode: "embedded" },
    embeddedHome: EMBEDDED,
    otherHomes: ["/Users/u/.slock"],
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
    hostMode: { mode: "embedded" }, embeddedHome: same, otherHomes: [],
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

test("age does not matter: a weeks-old success (app reopened after a long gap) is still finished, so no built-in host takes over the new home", async () => {
  assert.deepEqual(await run({ results: { "/Users/u/.slock": success({ finishedAt: "2026-08-01T00:00:00Z" }) } }), { to: "/Users/u/.slock" });
  assert.deepEqual(await run({ results: { "/Users/u/.slock": success({ finishedAt: null }) } }), { to: "/Users/u/.slock" });
});

test("a result about some other home is not ours", async () => {
  assert.equal(await run({ results: { "/Users/u/.slock": success({ from: "/somewhere/else", to: "/Users/u/.slock" }) } }), null);
});

test("the new home must exist as a directory", async () => {
  assert.equal(await run({ results: { "/Users/u/.slock": success() }, toExists: false }), null);
});

const marker = (pid: number): InProgressMarker => ({ pid, from: "/h/old", to: "/h/.slock", startedAt: "2026-10-09T12:00:00Z", home: "/h/old" });

test("a migration still running at launch is waited for (and only then does startup go on)", async () => {
  let alive = 3;
  const waits: number[] = [];
  const waited = await waitForRunningMigration({
    hostMode: { mode: "embedded" }, homes: ["/h/old", "/h/.slock"],
    readMarker: async (home) => (home === "/h/.slock" ? marker(4242) : null),
    isAlive: async () => alive-- > 0, sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(waited, true);
  assert.ok(waits.length >= 2, "polled until the process was gone");
});

test("nothing running / stale marker of a dead pid / already standalone: no waiting", async () => {
  const base = { homes: ["/h/old"], sleep: async () => { throw new Error("must not sleep"); } };
  assert.equal(await waitForRunningMigration({ ...base, hostMode: { mode: "embedded" }, readMarker: async () => null }), false);
  assert.equal(await waitForRunningMigration({ ...base, hostMode: { mode: "embedded" }, readMarker: async () => marker(1), isAlive: async () => false }), false);
  assert.equal(await waitForRunningMigration({ ...base, hostMode: { mode: "standalone", home: "/h" }, readMarker: async () => marker(1), isAlive: async () => true }), false);
});

test("waiting is bounded", async () => {
  const waited = await waitForRunningMigration({ hostMode: { mode: "embedded" }, homes: ["/h"], readMarker: async () => marker(1), isAlive: async () => true, sleep: async () => undefined, timeoutMs: -1 });
  assert.equal(waited, true);
});

test("built-in home gone + the standard home holds a migrated Computer: adopt it (never rebuild an empty built-in home)", async () => {
  const exists = (present: string[]) => async (p: string) => present.includes(p);
  const base = { hostMode: { mode: "embedded" } as const, embeddedHome: "/h/old", standardHome: "/h/.slock" };
  assert.equal(await findMigratedAwayHome({ ...base, exists: exists(["/h/.slock/computer/migrate-result.json"]) }), "/h/.slock");
  assert.equal(await findMigratedAwayHome({ ...base, exists: exists(["/h/.slock/computer/run/service.sock"]) }), "/h/.slock");
  assert.equal(await findMigratedAwayHome({ ...base, exists: exists(["/h/.slock/computer/migrate-in-progress.json"]) }), "/h/.slock");
});

test("…but not when the built-in home still exists, when it IS the standard home, when nothing was migrated, or in standalone mode", async () => {
  const exists = (present: string[]) => async (p: string) => present.includes(p);
  const base = { hostMode: { mode: "embedded" } as const, embeddedHome: "/h/old", standardHome: "/h/.slock" };
  assert.equal(await findMigratedAwayHome({ ...base, exists: exists(["/h/old", "/h/.slock/computer/migrate-result.json"]) }), null);
  assert.equal(await findMigratedAwayHome({ ...base, embeddedHome: "/h/.slock", exists: exists(["/h/.slock/computer/migrate-result.json"]) }), null);
  assert.equal(await findMigratedAwayHome({ ...base, exists: exists(["/h/.slock/computer/servers"]) }), null);
  assert.equal(await findMigratedAwayHome({ ...base, hostMode: { mode: "standalone", home: "/h/.slock" }, exists: exists(["/h/.slock/computer/migrate-result.json"]) }), null);
});

test("findRunningMigration: a live marker is returned without waiting; dead pid / none / standalone are not", async () => {
  const live = marker(4242);
  assert.deepEqual(await findRunningMigration({ hostMode: { mode: "embedded" }, homes: ["/h/old", "/h/.slock"], readMarker: async (h) => (h === "/h/.slock" ? live : null), isAlive: async () => true }), live);
  assert.equal(await findRunningMigration({ hostMode: { mode: "embedded" }, homes: ["/h"], readMarker: async () => live, isAlive: async () => false }), null);
  assert.equal(await findRunningMigration({ hostMode: { mode: "embedded" }, homes: ["/h"], readMarker: async () => null }), null);
  assert.equal(await findRunningMigration({ hostMode: { mode: "standalone", home: "/h" }, homes: ["/h"], readMarker: async () => live, isAlive: async () => true }), null);
});

test("isMigrationProcess: a live pid counts only if its command line is migrate-home (--from is not compared: symlink vs realpath spellings differ)", async () => {
  const m = { pid: 4242, from: "/Users/u/app/computer-slock-raft" };
  const cmd = (line: string | null) => async () => line;
  assert.equal(await isMigrationProcess(m, cmd("/x/raft-computer migrate-home --from /Users/u/app/computer-slock-raft --apply --json")), true);
  assert.equal(await isMigrationProcess(m, cmd("/x/raft-computer migrate-home --apply --json")), true, "no --from on the line: not contradicted");
  assert.equal(await isMigrationProcess(m, cmd("/usr/bin/vim notes.txt")), false, "a reused pid");
  assert.equal(await isMigrationProcess(m, cmd(null)), false, "no such process");
  assert.equal(await isMigrationProcess(m, cmd("/x/raft-computer migrate-home --from /Users/u/.slock-raft --apply --json")), true, "symlink spelling of --from vs the marker's realpath: still the running migration");
  assert.equal(await isMigrationProcess({ pid: 1, from: null }, cmd("raft-computer status --json")), false, "a different raft-computer command");
});
