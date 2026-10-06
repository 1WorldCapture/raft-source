#!/usr/bin/env node
// Offline-install verification for self-host tarballs (acceptance D3):
//   1. `npm i --offline` into a throwaway prefix — proves ZERO registry
//      access is needed (npm fails offline if any dependency must resolve).
//   2. The installed bin runs and reports --version.
//   3. The daemon performs a real network handshake: we start a local
//      server, launch the installed daemon against it, and require that the
//      server receives a connection attempt — exercising the bundled
//      HTTP/WS/undici stack beyond --version (PM verification requirement).
//
// Usage:
//   node scripts/verify-selfhost-tarball.mjs --cli <raft-v.tgz> [--daemon <raft-daemon-v.tgz>]
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument "${key}"`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function offlineInstall(prefix, tarball) {
  const res = spawnSync("npm", ["i", "--offline", "--no-audit", "--no-fund", "--prefix", prefix, tarball], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new Error(`npm i --offline failed for ${path.basename(tarball)}:\n${res.stderr}`);
  }
}

async function runBin(prefix, bin, args) {
  const res = spawnSync(path.join(prefix, "node_modules", ".bin", bin), args, {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, RAFT_HOME: path.join(prefix, "home"), SLOCK_HOME: path.join(prefix, "home") },
  });
  if (res.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

/** Start a mock server and require the daemon to reach out to it. */
async function verifyDaemonHandshake(prefix) {
  let sawRequest = false;
  const server = createServer((req, res) => {
    sawRequest = true;
    res.writeHead(404).end();
  });
  // Also catch WebSocket upgrade attempts (the daemon's primary channel).
  server.on("upgrade", (req, socket) => {
    sawRequest = true;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const home = path.join(prefix, "home2");
  const daemon = spawn(
    path.join(prefix, "node_modules", ".bin", "raft-daemon"),
    ["--server-url", `http://127.0.0.1:${port}`, "--api-key", "sk_machine_selfhostverify"],
    { env: { ...process.env, RAFT_HOME: home, SLOCK_HOME: home }, stdio: "ignore" },
  );
  try {
    const deadline = Date.now() + 30_000;
    while (!sawRequest && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!sawRequest) throw new Error("daemon never contacted the server within 30s (bundled network stack broken?)");
  } finally {
    daemon.kill("SIGKILL");
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.cli) throw new Error("--cli <tarball> is required");
  const failures = [];
  for (const [label, tarball] of [["cli", args.cli], ["daemon", args.daemon]].filter(([, t]) => t)) {
    const prefix = await mkdtemp(path.join(tmpdir(), `selfhost-verify-${label}-`));
    try {
      offlineInstall(prefix, tarball);
      if (label === "cli") {
        const out = runBin(prefix, "raft", ["--version"]);
        if (!out.trim()) throw new Error("raft --version printed nothing");
        console.log(`[selfhost-verify] cli offline install + --version OK (${out.trim().split("\n")[0]})`);
      } else {
        runBin(prefix, "raft-daemon", ["--version"]);
        await verifyDaemonHandshake(prefix);
        console.log("[selfhost-verify] daemon offline install + --version + server handshake OK");
      }
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  }
  if (failures.length) {
    console.error(`[selfhost-verify] FAILED\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("[selfhost-verify] all OK");
}

main().catch((err) => {
  console.error(`[selfhost-verify] ${err.message}`);
  process.exit(1);
});
