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
//
// Concurrency: every in-flight refresh carries the generation it was started
// under. A late response from a previous generation (config changed, pin
// engaged, config invalidated, or test reset) can neither commit its result
// nor clear the newer generation's bookkeeping. Each request also carries a
// hard deadline covering fetch AND body parsing, so a hanging upstream can
// never permanently occupy the refresh slot.

import {
  computerReleaseIdentity,
  readComputerDeploymentConfig,
  type ComputerDeploymentSetupConfig,
} from "../config/computerDeploymentConfig.js";
import {
  bothComputerVersionsKnown,
  clearClockTimeout,
  isComputerOutdated,
  setClockTimeout,
} from "@botiverse/raft-shared";

/** Hands app slug shared with install.sh and the CLI release authority. */
const HANDS_COMPUTER_APP_SLUG = "raft-computer-cli";

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** Hard deadline for one version lookup, covering response wait and body read. */
const DEFAULT_FETCH_DEADLINE_MS = 10_000;

let fetchDeadlineMs = DEFAULT_FETCH_DEADLINE_MS;

interface LatestVersionCache {
  identity: string;
  version: string | null;
  lastFetchTime: number;
}

let cache: LatestVersionCache | null = null;
let refreshPromise: Promise<void> | null = null;
let refreshIdentity: string | null = null;
/**
 * Monotonic generation of the resolve context. Bumped whenever the effective
 * source changes (identity switch, pin, invalidation, test reset) so stale
 * in-flight requests can detect they no longer own the cache.
 */
let refreshGeneration = 0;
/**
 * Identity of the current resolve context. Every getLatest call — including
 * one that only HITS the cache — re-establishes this: switching identity
 * without starting a refresh must still retire the previous identity's
 * in-flight request, or its late response would overwrite the cache the
 * caller just relied on.
 */
let currentIdentity: string | null = null;
let refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;

function bumpGeneration(): void {
  refreshGeneration += 1;
  refreshPromise = null;
  refreshIdentity = null;
  currentIdentity = null;
}

export function getLatestComputerVersion(): Promise<string | null> {
  const result = readComputerDeploymentConfig();
  if (result.status !== "ready") {
    // Unconfigured or invalid deployment → unknown. A background refresh under
    // the old source would be equally wrong; retire it.
    bumpGeneration();
    cache = null;
    return Promise.resolve(null);
  }

  const { config } = result;
  if (config.pinnedVersion) {
    // The deployment pin is the authoritative target version. It also retires
    // any in-flight channel resolution: the pin answer never depends on it.
    bumpGeneration();
    cache = null;
    return Promise.resolve(config.pinnedVersion);
  }

  const identity = computerReleaseIdentity(config);
  if (currentIdentity !== identity) {
    // A different source is now effective. Retire any in-flight refresh from
    // the previous identity — including when this call goes on to HIT the
    // cache and starts no refresh of its own: a late response from the old
    // identity must not overwrite what the caller just read.
    bumpGeneration();
    currentIdentity = identity;
  }
  const now = Date.now();
  if (cache && cache.identity === identity && cache.version && now - cache.lastFetchTime < refreshIntervalMs) {
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
  // The generation was already advanced by the getLatest caller when the
  // effective identity changed, retiring any in-flight previous-source
  // request before this one starts.
  if (refreshPromise && refreshIdentity === identity) return refreshPromise;
  const generation = refreshGeneration;
  refreshIdentity = identity;
  refreshPromise = fetchLatestComputerVersion(config)
    .then((version) => {
      // Only a successful parse updates the cache, and only while this
      // generation still owns the resolve context: a stale request from a
      // PREVIOUS source resolving late must never overwrite or evict the
      // current source's cached value.
      if (version !== null && refreshGeneration === generation) {
        cache = { identity, version, lastFetchTime: Date.now() };
      }
    })
    .finally(() => {
      // Only the owning generation may clear the coalescing slots; an older
      // request finishing late must not clobber a newer refresh's state.
      if (refreshGeneration === generation) {
        refreshPromise = null;
        refreshIdentity = null;
      }
    });
  return refreshPromise;
}

async function fetchLatestComputerVersion(
  config: ComputerDeploymentSetupConfig,
): Promise<string | null> {
  // The deadline covers fetch AND body parsing: a hanging response head or a
  // body that never ends must release the refresh slot, keep the same-identity
  // cached value, and let the next call retry.
  const controller = new AbortController();
  const timeoutId = setClockTimeout(() => controller.abort(), fetchDeadlineMs);
  try {
    if (config.backend === "hands") {
      const channel = config.installChannel === "alpha" ? "alpha" : "main";
      const url = `${config.handsOrigin}/public/v2/apps/${HANDS_COMPUTER_APP_SLUG}/latest?channel=${encodeURIComponent(channel)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      // Anchor the version inside the "build" object so strings elsewhere in
      // the response (release notes, fallback release) can never be mistaken
      // for it — the same anchoring install.sh applies.
      const data = (await res.json()) as { build?: { version?: unknown } };
      const version = data.build?.version;
      return typeof version === "string" && version.length > 0 ? version : null;
    }

    const res = await fetch(`${config.releaseBase}/manifest.json`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" && data.version.length > 0 ? data.version : null;
  } catch {
    // Network lookup is best-effort; fall back to the last cached value.
    return null;
  } finally {
    clearClockTimeout(timeoutId);
  }
}

export function __resetLatestComputerVersionForTest(): void {
  bumpGeneration();
  cache = null;
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS;
  fetchDeadlineMs = DEFAULT_FETCH_DEADLINE_MS;
}

/** Test hook: make an already-cached value expire (or never expire with Infinity). */
export function __setLatestComputerRefreshIntervalForTest(ms: number): void {
  refreshIntervalMs = ms;
}

/** Test hook: shrink the per-request fetch deadline for timeout regressions. */
export function __setLatestComputerFetchDeadlineForTest(ms: number): void {
  fetchDeadlineMs = ms;
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
