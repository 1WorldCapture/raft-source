#!/usr/bin/env node
const match = process.version.match(/^v?(\d+)\./);
const major = match ? Number.parseInt(match[1], 10) : 0;
if (major < 20) {
  process.stderr.write("Error: Node " + (process.version || "<unknown>") + " is unsupported; raft requires Node >=20 before loading CLI runtime dependencies.\n");
  process.stderr.write("No network requests, credentials, or local state were touched.\n");
  process.stderr.write("Next action: Install/activate Node 24.15.0 (the repository pin), then retry.\n");
  process.exit(1);
}
process.env.SLOCK_CLI_INVOCATION_NAME = "raft";
await import("./index.js");
