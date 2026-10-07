// Test-env guardrail — loaded via vitest setupFiles before any test runs.
//
// Two invariants:
// 1. Managed-runtime markers from the host shell must never leak into this
//    process: server tests spawn the real CLI with `{ ...process.env }`, and
//    a leaked SLOCK_CLI_TRANSPORT_DIR makes the spawned CLI fail closed with
//    MANAGED_WRAPPER_UNAVAILABLE before any request reaches the server.
// 2. The effective Raft/Slock home must never point at — or fall back to —
//    the real user homes. resolveRaftHome() prefers RAFT_HOME over the
//    legacy SLOCK_HOME, so an inherited RAFT_HOME is dropped and SLOCK_HOME
//    is pinned to a per-worker temp directory. Tests that exercise home
//    resolution set their own values AFTER this setup runs.

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MANAGED_RUNTIME_MARKERS = [
  "SLOCK_CLI_TRANSPORT_DIR",
  "SLOCK_AGENT_LAUNCH_DIR",
  "SLOCK_AGENT_PROXY_URL",
  "SLOCK_AGENT_TOKEN_FILE",
  "SLOCK_AGENT_ID",
] as const;

for (const key of MANAGED_RUNTIME_MARKERS) delete process.env[key];

delete process.env.RAFT_HOME;

const realHome = homedir();
const unsafe = (value: string | undefined): boolean =>
  value === undefined || value.length === 0 || value.startsWith(realHome);

if (unsafe(process.env.SLOCK_HOME)) {
  const isolatedHome = mkdtempSync(join(tmpdir(), "raft-server-tests-"));
  process.env.SLOCK_HOME = join(isolatedHome, "slock");
}
