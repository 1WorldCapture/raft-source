// Hermetic state-root isolation for the Computer test suite (contract:
// #bugfix task #5, Anna's spec + review round 2).
//
// WHY THIS EXISTS: `resolveRaftHome()` prefers RAFT_HOME over SLOCK_HOME.
// Managed agent terminals inherit RAFT_HOME pointing at a LIVE state root
// (~/.slock-raft), so any test that sets only SLOCK_HOME — as every local
// `withHome` helper in this suite used to — silently operated on the real
// root: real user sessions deleted, real runners stopped (the 2026-10-02
// production incidents).
//
// Assertions bind to DIRECTORIES THIS PROCESS ALLOCATED (a registry), never
// to path-name patterns: a directory that merely LOOKS like a test temp root
// but was not allocated here must still fail the guard (review finding: a
// name-prefix check let an arbitrary external directory through).
//
//  - withHermeticHome: per-test override that sets BOTH home variables,
//    registers the root, and asserts the EFFECTIVE resolution equals it.
//  - assertStateRootHermetic: the same ownership check for tests that keep
//    a bespoke home fixture, or with an explicit expected root.
//
// Cleanup only ever removes roots registered (and created) here.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRaftHome } from "../paths.js";

/**
 * Roots allocated by THIS test process (the global setup root and every
 * withHermeticHome root). Ownership, not naming, is what the guards check.
 */
const allocatedRoots = new Set<string>();

/** Register an allocated root; returns the resolved path. */
export function registerHermeticRoot(root: string): string {
  const resolved = path.resolve(root);
  allocatedRoots.add(resolved);
  return resolved;
}

function isOwnedRoot(dir: string): boolean {
  if (allocatedRoots.has(dir)) return true;
  // A subdirectory of an allocated root (state files live under <root>/...).
  for (const root of allocatedRoots) {
    if (dir.startsWith(root + path.sep)) return true;
  }
  return false;
}

/**
 * Assert that the state root the code UNDER TEST will actually resolve is a
 * directory this process allocated. Pass `expected` to pin the exact root
 * (e.g. a withHome fixture); without it, any registered root passes. This
 * checks the resolution result, not the environment variables — a precedence
 * bug or an unregistered external directory cannot pass it.
 */
export function assertStateRootHermetic(expected?: string, label = "state root"): string {
  const resolved = resolveRaftHome();
  if (expected !== undefined) {
    const want = path.resolve(expected);
    if (resolved !== want) {
      throw new Error(
        `HERMETIC_STATE_ROOT_VIOLATION (${label}): resolveRaftHome() returned ${resolved}, expected the allocated ${want}.`,
      );
    }
    return resolved;
  }
  if (!isOwnedRoot(resolved)) {
    throw new Error(
      `HERMETIC_STATE_ROOT_VIOLATION (${label}): resolveRaftHome() returned ${resolved}, ` +
        `which is not a directory allocated by this test run. Refusing to run state-writing tests ` +
        `against an unowned home.`,
    );
  }
  return resolved;
}

/**
 * Per-test hermetic home: creates a temp root, points BOTH home variables at
 * it (RAFT_HOME wins in resolveRaftHome — setting only SLOCK_HOME is the
 * original leak), registers it, asserts the resolution equals it, and
 * restores/cleans only what it created.
 */
export async function withHermeticHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = registerHermeticRoot(await mkdtemp(path.join(tmpdir(), "raft-computer-hermetic-")));
  const previousRaft = process.env.RAFT_HOME;
  const previousSlock = process.env.SLOCK_HOME;
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  try {
    assertStateRootHermetic(home, "withHermeticHome");
    return await fn(home);
  } finally {
    if (previousRaft === undefined) delete process.env.RAFT_HOME;
    else process.env.RAFT_HOME = previousRaft;
    if (previousSlock === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = previousSlock;
    allocatedRoots.delete(home);
    await rm(home, { recursive: true, force: true });
  }
}

// --- shared helpers end. The global setup entry lives in
// hermeticStateRootSetup.ts so importing these assertions from a test never
// re-runs setup side effects. ---
