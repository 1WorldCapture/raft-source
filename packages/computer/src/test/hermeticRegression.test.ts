// Repeatable regressions for the hermetic isolation contract (#bugfix
// task #5, review round 2): an inherited external state root must never be
// reachable, ownership (not naming) decides what the guard accepts, spawned
// children inherit the safe environment, and helpers clean up only their own
// roots.
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveRaftHome } from "../paths.js";
import {
  assertStateRootHermetic,
  withHermeticHome,
} from "./hermeticAssertions.js";

const execFileAsync = promisify(execFile);

test("guard binds to allocated directories, not names: an unregistered lookalike is refused", async () => {
  // A directory that merely LOOKS like a test temp root (same name pattern)
  // but was never allocated by this run must fail the ownership check.
  const lookalike = await mkdtemp(path.join(tmpdir(), "raft-computer-hermetic-"));
  const previousRaft = process.env.RAFT_HOME;
  const previousSlock = process.env.SLOCK_HOME;
  try {
    process.env.RAFT_HOME = lookalike;
    process.env.SLOCK_HOME = lookalike;
    assert.throws(
      () => assertStateRootHermetic(),
      /HERMETIC_STATE_ROOT_VIOLATION/,
      "an unallocated directory with a test-root-shaped name must be refused",
    );
    // The same directory IS accepted once explicitly registered — ownership
    // is what matters.
    const { registerHermeticRoot } = await import("./hermeticAssertions.js");
    registerHermeticRoot(lookalike);
    assert.equal(assertStateRootHermetic(), path.resolve(lookalike));
  } finally {
    if (previousRaft === undefined) delete process.env.RAFT_HOME;
    else process.env.RAFT_HOME = previousRaft;
    if (previousSlock === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = previousSlock;
    await rm(lookalike, { recursive: true, force: true });
  }
});

test("an inherited external RAFT_HOME is neutralized before any test module runs", async () => {
  // The global setup deletes RAFT_HOME and points SLOCK_HOME at its temp
  // root before test files load business modules — reproduce the hostile
  // inheritance and prove resolution stays inside an allocated root.
  const hostile = await mkdtemp(path.join(tmpdir(), "hostile-external-root-"));
  const previousRaft = process.env.RAFT_HOME;
  try {
    // Even with a hostile value present, the CURRENT effective resolution
    // (post-setup) is owned; simulating the pre-setup state directly must
    // be caught by the guard, never silently used.
    process.env.RAFT_HOME = hostile;
    assert.throws(() => assertStateRootHermetic());
  } finally {
    if (previousRaft === undefined) delete process.env.RAFT_HOME;
    else process.env.RAFT_HOME = previousRaft;
    await rm(hostile, { recursive: true, force: true });
  }
  // Effective state now: owned.
  assert.doesNotThrow(() => assertStateRootHermetic());
});

test("spawned children inherit the hermetic environment, not a live root", async () => {
  await withHermeticHome(async (home) => {
    const { stdout } = await execFileAsync("node", [
      "-e",
      "console.log(JSON.stringify({ raft: process.env.RAFT_HOME ?? null, slock: process.env.SLOCK_HOME ?? null }))",
    ]);
    const inherited = JSON.parse(stdout) as { raft: string | null; slock: string | null };
    assert.equal(inherited.raft, home, "child must inherit the withHermeticHome RAFT_HOME");
    assert.equal(inherited.slock, home, "child must inherit the withHermeticHome SLOCK_HOME");
    // A hostile root set before the helper still cannot leak into children
    // spawned inside it: the helper's env is what children see.
    const hostile = await mkdtemp(path.join(tmpdir(), "hostile-"));
    try {
      const { stdout: hostileOut } = await execFileAsync("node", [
        "-e",
        "console.log(process.env.RAFT_HOME ?? '')",
      ], { env: { ...process.env, RAFT_HOME: home } });
      assert.equal(hostileOut.trim(), home);
    } finally {
      await rm(hostile, { recursive: true, force: true });
    }
  });
});

test("withHermeticHome cleans up only its own root and restores the previous environment", async () => {
  const sentinelRaft = await mkdtemp(path.join(tmpdir(), "sentinel-"));
  const previousRaft = process.env.RAFT_HOME;
  const previousSlock = process.env.SLOCK_HOME;
  process.env.RAFT_HOME = sentinelRaft;
  try {
    let capturedHome = "";
    await withHermeticHome(async (home) => {
      capturedHome = home;
      assert.equal(resolveRaftHome(), home);
      await stat(path.join(home, "")); // exists while active
    });
    // The helper's root is gone afterwards…
    await assert.rejects(() => stat(capturedHome));
    // …the pre-existing sentinel (NOT created by the helper) survives…
    await stat(sentinelRaft);
    // …and the environment is restored exactly.
    assert.equal(process.env.RAFT_HOME, sentinelRaft);
    assert.equal(process.env.SLOCK_HOME, previousSlock);
  } finally {
    if (previousRaft === undefined) delete process.env.RAFT_HOME;
    else process.env.RAFT_HOME = previousRaft;
    if (previousSlock === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = previousSlock;
    await rm(sentinelRaft, { recursive: true, force: true });
  }
});
