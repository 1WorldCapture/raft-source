// Hermetic state-root isolation for the Computer test suite (contract:
// #bugfix task #5, Anna's spec).
//
// WHY THIS EXISTS: `resolveRaftHome()` prefers RAFT_HOME over SLOCK_HOME.
// Managed agent terminals inherit RAFT_HOME pointing at a LIVE state root
// (~/.slock-raft), so any test that sets only SLOCK_HOME — as every local
// `withHome` helper in this suite used to — silently operated on the real
// root: real user sessions deleted, real runners stopped (the 2026-10-02
// production incidents). This module closes that class of leak three ways:
//
//  1. Global setup (vitest setupFiles, runs before each test file's imports
//     load any business module): point BOTH RAFT_HOME and SLOCK_HOME at a
//     throwaway temp root. Even a test that manages no environment of its
//     own can no longer resolve to an inherited real root. Child processes
//     inherit the env, so spawned CLIs/services are covered too.
//  2. withHermeticHome: the per-test override replacing the old SLOCK_HOME-only
//     helpers. Sets BOTH variables and — per spec — ASSERTS the effective
//     resolution (`resolveRaftHome()`) actually lands inside the temp root,
//     instead of trusting the environment write alone.
//  3. assertStateRootHermetic: the same final-directory assertion for tests
//     that keep a bespoke home fixture instead of the shared helper.
//
// Cleanup only ever removes directories this process created under the OS
// temp dir.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRaftHome } from "../paths.js";

const HERMETIC_PREFIXES = [path.join(tmpdir(), "raft-computer-hermetic-"), path.join(tmpdir(), "slock-pr-"), path.join(tmpdir(), "raft-computer-")];

function isInsideTempRoot(dir: string): boolean {
  return HERMETIC_PREFIXES.some((prefix) => dir.startsWith(prefix));
}

/**
 * Assert that the state root the code UNDER TEST will actually resolve is a
 * throwaway temp directory. This checks the resolution result, not the env
 * variables — a precedence bug or a missed override cannot pass it.
 */
export function assertStateRootHermetic(label = "state root"): string {
  const resolved = resolveRaftHome();
  if (!isInsideTempRoot(resolved)) {
    throw new Error(
      `HERMETIC_STATE_ROOT_VIOLATION (${label}): resolveRaftHome() returned ${resolved}, ` +
        `which is outside the test temp roots. Refusing to run state-writing tests against a real home. ` +
        `Both RAFT_HOME and SLOCK_HOME must point at a temp directory.`,
    );
  }
  return resolved;
}

/**
 * Per-test hermetic home: creates a temp root, points BOTH home variables at
 * it (RAFT_HOME wins in resolveRaftHome — setting only SLOCK_HOME is the
 * original leak), asserts the resolution landed inside it, and restores/cleans
 * only what it created.
 */
export async function withHermeticHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "raft-computer-hermetic-"));
  const previousRaft = process.env.RAFT_HOME;
  const previousSlock = process.env.SLOCK_HOME;
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  try {
    const resolved = resolveRaftHome();
    if (resolved !== path.resolve(home)) {
      throw new Error(
        `HERMETIC_STATE_ROOT_VIOLATION: expected resolution ${path.resolve(home)} but got ${resolved}.`,
      );
    }
    return await fn(home);
  } finally {
    if (previousRaft === undefined) delete process.env.RAFT_HOME;
    else process.env.RAFT_HOME = previousRaft;
    if (previousSlock === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = previousSlock;
    await rm(home, { recursive: true, force: true });
  }
}

// --- shared helpers end. The global setup entry lives in
// hermeticStateRootSetup.ts so importing these assertions from a test never
// re-runs setup side effects. ---
