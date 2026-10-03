# k-receipt-chain — container acceptance chain (task #11)

Replayable acceptance script for the receipt-recovery path: a REAL upgrade
transaction whose coordinator is SIGKILLed at a defined journal phase, the
fresh-engine redo settling the transaction, the computer recovery entry
acknowledging the identity-less receipt through its six gates, and the NEXT
upgrade passing end to end.

## What is real

- The production `createUpgrader` wiring: real journal, real slots, real
  fs, real detached service processes, real pids (the production host
  adapter; only the managed-set reads are static-matched to the acceptance
  app — the harness-standard deviation).
- Real signed release artifacts served over HTTP (static manifest source).
- The recovery entry runs in-process against the durable state the crashed
  coordinator left behind.

Both redo settle shapes are accepted and each runs the full acceptance:
`promoted` (successor evidence verified) checks the target version,
`rolled-back` (engine fail-safe) checks the restored from-version. Both
assert identities absent + exactly one audit line + the next upgrade to
9.9.92 promoting.

## Run (linux container)

The chain is POSIX-only (unix sockets) and needs the workspace's native
dependencies for the CONTAINER architecture — do not reuse a host
`node_modules` (darwin binaries do not run on linux):

```sh
colima start                       # or any docker runtime
docker build -t raft-e2e-iso /path/to/e2e-iso   # node:22-bookworm-slim + chromium
docker run -d --name k-chain raft-e2e-iso
docker exec k-chain mkdir -p /testroot/ws
rsync -a --exclude node_modules --exclude .git <worktree>/ /tmp/t11-src/
docker cp /tmp/t11-src/. k-chain:/testroot/ws/
docker exec k-chain sh -c "cd /testroot/ws && pnpm install --frozen-lockfile"
docker exec k-chain sh -c "cd /testroot/ws/packages/computer && node --import tsx scripts/k-receipt-chain/chain.ts"
```

Notes:
- `pnpm install --frozen-lockfile` INSIDE the container installs the
  platform-native build tools (esbuild linux/arm64 etc.) — that is the
  assumption this script makes; a host-installed tree will not run here.
- Run the suite as non-root if you also run the fault-injection suites
  (`kCarrierPromoteDiagnostics.patch.test.ts` chmods directories to inject
  EACCES; root ignores permission bits). The chain itself is root-safe.
- One run takes ~4s; the acceptance evidence is the trailing `EVIDENCE`
  JSON line (`"result":"PASS"`), exit code 0.
