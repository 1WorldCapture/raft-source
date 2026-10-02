// Private-deployment Computer onboarding configuration (contract v1).
//
// packages/server/.env is the authority for this config group. The same parse
// feeds both the public GET /api/deployment/computer-setup endpoint (which the
// web onboarding surfaces consume at runtime) and computerVersionService (the
// upgrade-indicator authority), so a deployment can never advertise one release
// source while comparing versions against another.
//
// Contract rules encoded here:
//   - RAFT_PUBLIC_ORIGIN / RAFT_COMPUTER_RELEASE_BASE /
//     RAFT_COMPUTER_HANDS_ORIGIN are origins-or-root-URLs only: no credentials,
//     query, or fragment; HTTPS everywhere except explicit loopback hosts.
//   - Both release backends require RAFT_COMPUTER_RELEASE_BASE — even Hands
//     mode downloads the installer and version artifacts from it.
//   - No backend downgrade: an unresolvable backend is "invalid", never
//     silently swapped for the official CDN.
//   - Missing vs invalid are distinct, report field NAMES only, and never echo
//     the raw (possibly malformed) values back through the public endpoint.

export type ComputerReleaseBackend = "hands" | "manifest";

/** `latest`, the hands-only `alpha` debug channel, or `pinned:<semver>`. */
export type ComputerInstallChannel = "latest" | "alpha" | `pinned:${string}`;

/** A fully validated private-deployment Computer setup configuration. */
export interface ComputerDeploymentSetupConfig {
  /** Origin only (scheme://host[:port]) — the setup `--server-url` value. */
  serverUrl: string;
  backend: ComputerReleaseBackend;
  /**
   * Release file root. May contain a path (e.g. https://host/computer) with
   * trailing slashes normalized away; joining is always `${base}/${file}`.
   */
  releaseBase: string;
  /** Present only for the hands backend — the version authority origin. */
  handsOrigin: string | null;
  /** Deployment version pin, or null for channel resolution. */
  pinnedVersion: string | null;
  installChannel: ComputerInstallChannel;
}

export type ComputerDeploymentConfigResult =
  | { status: "ready"; config: ComputerDeploymentSetupConfig }
  | { status: "missing" | "invalid"; fields: string[] };

export const RAFT_PUBLIC_ORIGIN_ENV = "RAFT_PUBLIC_ORIGIN";
export const RAFT_COMPUTER_RELEASE_BASE_ENV = "RAFT_COMPUTER_RELEASE_BASE";
export const RAFT_COMPUTER_RELEASE_BACKEND_ENV = "RAFT_COMPUTER_RELEASE_BACKEND";
export const RAFT_COMPUTER_HANDS_ORIGIN_ENV = "RAFT_COMPUTER_HANDS_ORIGIN";
export const RAFT_COMPUTER_PINNED_VERSION_ENV = "RAFT_COMPUTER_PINNED_VERSION";
export const RAFT_COMPUTER_INSTALL_CHANNEL_ENV = "RAFT_COMPUTER_INSTALL_CHANNEL";

const VERSION_PIN_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function parseHttpUrl(raw: string | undefined | null): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Shared URL gate for every configured origin/root: http(s) only, no
 * credentials, no query, no fragment. Non-loopback hosts must use HTTPS —
 * loopback HTTP stays legal for local development.
 */
function parseConfiguredUrl(raw: string | undefined | null): { origin: string; path: string } | null {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.protocol !== "https:" && !isLoopbackHostname(parsed.hostname)) return null;
  return { origin: parsed.origin, path: parsed.pathname };
}

/** An origin-only value: no path component allowed. */
function parseOriginValue(raw: string | undefined | null): string | null {
  const parsed = parseConfiguredUrl(raw);
  if (!parsed) return null;
  if (parsed.path && parsed.path !== "/") return null;
  return parsed.origin;
}

/** A release-file root: path allowed, trailing slashes normalized away. */
function parseReleaseBaseValue(raw: string | undefined | null): string | null {
  const parsed = parseConfiguredUrl(raw);
  if (!parsed) return null;
  return `${parsed.origin}${parsed.path}`.replace(/\/+$/, "");
}

/**
 * Parse and validate the deployment Computer config group.
 *
 * Invalid input wins over missing input (a malformed value must surface as
 * "invalid", not be reported as merely absent). Field names only travel in the
 * result — never the raw values.
 */
export function readComputerDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): ComputerDeploymentConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];

  const rawServerUrl = env[RAFT_PUBLIC_ORIGIN_ENV]?.trim();
  if (!rawServerUrl) missing.push(RAFT_PUBLIC_ORIGIN_ENV);
  else if (!parseOriginValue(rawServerUrl)) invalid.push(RAFT_PUBLIC_ORIGIN_ENV);

  const rawReleaseBase = env[RAFT_COMPUTER_RELEASE_BASE_ENV]?.trim();
  if (!rawReleaseBase) missing.push(RAFT_COMPUTER_RELEASE_BASE_ENV);
  else if (!parseReleaseBaseValue(rawReleaseBase)) invalid.push(RAFT_COMPUTER_RELEASE_BASE_ENV);

  const rawBackend = env[RAFT_COMPUTER_RELEASE_BACKEND_ENV]?.trim();
  const backend: ComputerReleaseBackend =
    !rawBackend || rawBackend === "hands" ? "hands"
    : rawBackend === "manifest" ? "manifest"
    : "invalid" as ComputerReleaseBackend;
  if (backend === ("invalid" as ComputerReleaseBackend)) {
    invalid.push(RAFT_COMPUTER_RELEASE_BACKEND_ENV);
  }

  const rawHandsOrigin = env[RAFT_COMPUTER_HANDS_ORIGIN_ENV]?.trim();
  let handsOrigin: string | null = null;
  if (backend === "hands") {
    if (!rawHandsOrigin) missing.push(RAFT_COMPUTER_HANDS_ORIGIN_ENV);
    else if (!parseOriginValue(rawHandsOrigin)) invalid.push(RAFT_COMPUTER_HANDS_ORIGIN_ENV);
    else handsOrigin = parseOriginValue(rawHandsOrigin);
  }
  // The manifest backend never reads this field; a stray value is ignored
  // rather than rejected so switching backends does not require cleanup.

  const rawPinnedVersion = env[RAFT_COMPUTER_PINNED_VERSION_ENV]?.trim() ?? "";
  let pinnedVersion: string | null = null;
  if (rawPinnedVersion) {
    if (VERSION_PIN_RE.test(rawPinnedVersion)) pinnedVersion = rawPinnedVersion;
    else invalid.push(RAFT_COMPUTER_PINNED_VERSION_ENV);
  }

  // Only the alpha debug channel can be requested through this env. The pin
  // comes exclusively from RAFT_COMPUTER_PINNED_VERSION so the channel file
  // stays the single machine-level pin/channel state (contract: no second pin).
  const rawInstallChannel = env[RAFT_COMPUTER_INSTALL_CHANNEL_ENV]?.trim() ?? "";
  let requestedAlpha = false;
  if (rawInstallChannel) {
    if (rawInstallChannel === "alpha") requestedAlpha = true;
    else invalid.push(RAFT_COMPUTER_INSTALL_CHANNEL_ENV);
  }
  if (requestedAlpha && backend !== "hands") {
    // The manifest backend has no alpha channel; refuse rather than
    // substituting latest (contract: never pass latest off as alpha).
    invalid.push(RAFT_COMPUTER_INSTALL_CHANNEL_ENV);
  }

  if (invalid.length > 0) return { status: "invalid", fields: invalid };
  if (missing.length > 0) return { status: "missing", fields: missing };

  let installChannel: ComputerInstallChannel;
  if (pinnedVersion) installChannel = `pinned:${pinnedVersion}`;
  else if (requestedAlpha) installChannel = "alpha";
  else installChannel = "latest";

  return {
    status: "ready",
    config: {
      serverUrl: parseOriginValue(rawServerUrl)!,
      backend,
      releaseBase: parseReleaseBaseValue(rawReleaseBase)!,
      handsOrigin,
      pinnedVersion,
      installChannel,
    },
  };
}

/**
 * Identity of the release-resolution inputs. computerVersionService caches per
 * identity so a config change can never serve a version resolved under the old
 * source (contract: no cache reuse across config identity changes).
 */
export function computerReleaseIdentity(config: ComputerDeploymentSetupConfig): string {
  return JSON.stringify([
    config.backend,
    config.releaseBase,
    config.handsOrigin,
    config.installChannel,
  ]);
}
