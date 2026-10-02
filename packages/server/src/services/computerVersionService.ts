// Latest-known Raft Computer version for upgrade indicators.
//
// Since contract v1 this service resolves versions through the SAME
// deployment configuration as GET /api/deployment/computer-setup — never
// through a second, independently hardcoded source:
//   - A deployment pin IS the deployment target: returned without any network
//     lookup.
//   - hands backend: the configured Hands authority resolves the channel
//     (`build.version` from the public latest endpoint).
//   - manifest backend: the top-level `version` of the configured release
//     root's manifest.json.
//   - missing/invalid deployment config → unknown (null). There is
//     deliberately NO official-CDN fallback here: a misconfigured private
//     deployment must show "unknown", not compare against official versions.
//
// Surfaced through `GET /api/servers/:id/machines` as `latestComputerVersion`
// alongside the existing `latestDaemonVersion`. The server also derives each
// managed Computer row's `computerUpgradeAvailable` value from this authority
// so web surfaces consume a readback-backed comparison instead of guessing.
//
// Caching: hourly background refresh, cached value returned immediately so the
// REST path never blocks on a network call. The cache is keyed by the release
// identity (backend + base + authority + channel): a config change drops the
// old value instead of serving a version resolved under the previous source.
// Network failures keep the last value only under the SAME identity.

import {
  computerReleaseIdentity,
  readComputerDeploymentConfig,
  type ComputerDeploymentSetupConfig,
} from "../config/computerDeploymentConfig.js";
import { bothComputerVersionsKnown, isComputerOutdated } from "@botiverse/raft-shared";

/** Hands app slug shared with install.sh and the CLI release authority. */
const HANDS_COMPUTER_APP_SLUG = "raft-computer-cli";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

interface LatestVersionCache {
  identity: string;
  version: string | null;
  lastFetchTime: number;
}

let cache: LatestVersionCache | null = null;
let refreshPromise: Promise<void> | null = null;
let refreshIdentity: string | null = null;

export function getLatestComputerVersion(): Promise<string | null> {
  const result = readComputerDeploymentConfig();
  if (result.status !== "ready") {
    // Unconfigured or invalid deployment → unknown. A background refresh under
    // the old identity would be equally wrong, so drop it entirely.
    cache = null;
    return Promise.resolve(null);
  }

  const { config } = result;
  if (config.pinnedVersion) {
    // The deployment pin is the authoritative target version.
    cache = null;
    return Promise.resolve(config.pinnedVersion);
  }

  const identity = computerReleaseIdentity(config);
  const now = Date.now();
  if (cache && cache.identity === identity && cache.version && now - cache.lastFetchTime < REFRESH_INTERVAL_MS) {
    return Promise.resolve(cache.version);
  }

  void refreshLatestComputerVersion(config, identity);
  return Promise.resolve(cache && cache.identity === identity ? cache.version : null);
}

async function refreshLatestComputerVersion(
  config: ComputerDeploymentSetupConfig,
  identity: string,
): Promise<void> {
  // Coalesce only refreshes for the SAME identity: a config change mid-flight
  // must start its own resolution, not piggyback on the previous source's.
  if (refreshPromise && refreshIdentity === identity) return refreshPromise;
  refreshIdentity = identity;
  refreshPromise = fetchLatestComputerVersion(config)
    .then((version) => {
      // Only a successful parse updates the cache. A failure keeps the last
      // value under the same identity (best-effort refresh, retried on the
      // next call because lastFetchTime is untouched).
      if (version !== null) {
        cache = { identity, version, lastFetchTime: Date.now() };
      }
    })
    .finally(() => {
      refreshPromise = null;
      refreshIdentity = null;
    });
  return refreshPromise;
}

async function fetchLatestComputerVersion(
  config: ComputerDeploymentSetupConfig,
): Promise<string | null> {
  try {
    if (config.backend === "hands") {
      const channel = config.installChannel === "alpha" ? "alpha" : "main";
      const url = `${config.handsOrigin}/public/v2/apps/${HANDS_COMPUTER_APP_SLUG}/latest?channel=${encodeURIComponent(channel)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      // Anchor the version inside the "build" object so strings elsewhere in
      // the response (release notes, fallback release) can never be mistaken
      // for it — the same anchoring install.sh applies.
      const data = (await res.json()) as { build?: { version?: unknown } };
      const version = data.build?.version;
      return typeof version === "string" && version.length > 0 ? version : null;
    }

    const res = await fetch(`${config.releaseBase}/manifest.json`);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" && data.version.length > 0 ? data.version : null;
  } catch {
    // Network lookup is best-effort; fall back to the last cached value.
    return null;
  }
}

export function __resetLatestComputerVersionForTest(): void {
  cache = null;
  refreshPromise = null;
  refreshIdentity = null;
}

export function resolveComputerUpgradeAvailable(
  isComputer: boolean,
  computerVersion: string | null | undefined,
  latestComputerVersion: string | null | undefined,
): boolean | null {
  if (!isComputer) return null;
  if (!bothComputerVersionsKnown(computerVersion, latestComputerVersion)) {
    return null;
  }
  return isComputerOutdated(computerVersion, latestComputerVersion);
}
