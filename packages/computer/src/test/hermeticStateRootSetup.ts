// Global hermetic state-root setup (vitest setupFiles, #bugfix task #5).
//
// Runs before each test file's imports load any business module: BOTH home
// variables point at a throwaway temp root, so an inherited RAFT_HOME (a
// managed agent terminal pointing at a live ~/.slock-raft) can never leak
// state writes into a real home — for this process AND any child it spawns.
// See hermeticAssertions.ts for the per-test helpers and the rationale.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { assertStateRootHermetic, registerHermeticRoot } from "./hermeticAssertions.js";

const globalRoot = registerHermeticRoot(await mkdtemp(path.join(tmpdir(), "raft-computer-hermetic-")));
// DELETE the inherited RAFT_HOME rather than pointing it at the temp root:
// many contract tests build their env by spreading `...process.env` and then
// overriding only SLOCK_HOME — a setup-injected RAFT_HOME would silently win
// resolveRaftHome()'s precedence and reroute those tests into the shared
// global root. Removing it keeps the inherited live root neutralized AND
// leaves per-test SLOCK_HOME/withHome overrides authoritative.
delete process.env.RAFT_HOME;
process.env.SLOCK_HOME = globalRoot;

// Cleanup only what we created here, after the file's tests finish.
afterAll(async () => {
  await rm(globalRoot, { recursive: true, force: true });
});

// Fail at load time if the guard itself is broken — not after the first
// state write.
assertStateRootHermetic(globalRoot, "global setup");
