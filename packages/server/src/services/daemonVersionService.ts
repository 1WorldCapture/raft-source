// Fetch latest daemon version from npm registry, refresh hourly.
// Private deployments read the local /downloads manifest instead (task #4):
// the self-hosted server is the only release authority for its clients.
import { isPrivateDeploymentMode } from "@botiverse/raft-shared";
import { readFileSync } from "node:fs";
import path from "node:path";
let cachedLatestDaemonVersion: string | null = null;
let lastFetchTime = 0;
let refreshPromise: Promise<void> | null = null;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const DAEMON_LATEST_URL = "https://registry.npmjs.org/@botiverse/raft-daemon/latest";

export function getLatestDaemonVersion(): Promise<string | null> {
  const now = Date.now();
  if (cachedLatestDaemonVersion && now - lastFetchTime < REFRESH_INTERVAL_MS) {
    return Promise.resolve(cachedLatestDaemonVersion);
  }

  void refreshLatestDaemonVersion();
  return Promise.resolve(cachedLatestDaemonVersion);
}

async function refreshLatestDaemonVersion(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetchLatestDaemonVersion()
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

function readLocalLatestDaemonVersion(): string | null {
  try {
    // The daemon is NOT the CLI package (@botiverse/raft-daemon vs
    // @botiverse/raft — independent versions). The self-hosted release tree
    // records the daemon version the Computer SEA bundles in the COMPUTER
    // latest manifest ({version, daemonVersion}) — build-downloads stamps it
    // from the same-commit daemon package. Missing field degrades to null.
    const dir = process.env.RAFT_DOWNLOADS_DIR?.trim() || "/app/downloads";
    const parsed = JSON.parse(readFileSync(path.join(dir, "computer/manifest.json"), "utf8")) as { daemonVersion?: unknown };
    return typeof parsed.daemonVersion === "string" && parsed.daemonVersion ? parsed.daemonVersion : null;
  } catch {
    return null; // Same degradation as the offline external lookup.
  }
}

async function fetchLatestDaemonVersion(): Promise<void> {
  if (isPrivateDeploymentMode()) {
    const local = readLocalLatestDaemonVersion();
    if (local) {
      cachedLatestDaemonVersion = local;
      lastFetchTime = Date.now();
    }
    return;
  }
  try {
    const res = await fetch(DAEMON_LATEST_URL);
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      if (data.version) {
        cachedLatestDaemonVersion = data.version;
        lastFetchTime = Date.now();
      }
    }
  } catch {
    // Network lookup is best-effort; fall back to the last cached version.
  }
}

export function __resetLatestDaemonVersionForTest(): void {
  cachedLatestDaemonVersion = null;
  lastFetchTime = 0;
  refreshPromise = null;
}
