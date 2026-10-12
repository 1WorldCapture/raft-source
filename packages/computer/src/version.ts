import { createRequire } from "node:module";

declare const __RAFT_COMPUTER_VERSION__: string | undefined;
declare const __RAFT_DAEMON_VERSION__: string | undefined;
declare const __RAFT_CLI_VERSION__: string | undefined;
declare const __RAFT_COMPUTER_COMMIT_SHA__: string | undefined;
declare const __RAFT_COMPUTER_COMMIT_SHORT__: string | undefined;

/** Marker baked/returned when the commit could not be determined. */
export const UNKNOWN_COMMIT = "unknown";

export interface ComputerBuildProvenance {
  /** Full commit sha, or `unknown`. */
  sha: string;
  /** Short sha for logs, or `unknown`. */
  short: string;
  /** True only when a real sha was baked in. */
  known: boolean;
}

/**
 * Commit this Computer bundle was built from (task #32).
 *
 * The bundle version comes from package.json and is identical across commits,
 * so it cannot prove which commit produced a given `dist/` — during the 0.2.4
 * observation a stale `dist` reported the correct version. Builds without a git
 * checkout fall back to an explicit `unknown` rather than a missing field.
 */
export function readComputerProvenance(
  bakedSha: unknown = typeof __RAFT_COMPUTER_COMMIT_SHA__ === "string" ? __RAFT_COMPUTER_COMMIT_SHA__ : undefined,
  bakedShort: unknown = typeof __RAFT_COMPUTER_COMMIT_SHORT__ === "string" ? __RAFT_COMPUTER_COMMIT_SHORT__ : undefined,
): ComputerBuildProvenance {
  const read = (value: unknown): string =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : UNKNOWN_COMMIT;
  const sha = read(bakedSha);
  const known = sha !== UNKNOWN_COMMIT;
  const short = read(bakedShort);
  return {
    sha,
    short: short !== UNKNOWN_COMMIT ? short : (known ? sha.slice(0, 12) : UNKNOWN_COMMIT),
    known,
  };
}

export const COMPUTER_PROVENANCE = readComputerProvenance();

function readBakedComputerVersion(): string | undefined {
  return typeof __RAFT_COMPUTER_VERSION__ === "string" ? __RAFT_COMPUTER_VERSION__ : undefined;
}

function readBakedDaemonVersion(): string | undefined {
  return typeof __RAFT_DAEMON_VERSION__ === "string" ? __RAFT_DAEMON_VERSION__ : undefined;
}

function readBakedCliVersion(): string | undefined {
  return typeof __RAFT_CLI_VERSION__ === "string" ? __RAFT_CLI_VERSION__ : undefined;
}

export function readComputerVersion(
  moduleUrl: string = import.meta.url,
  bakedVersion: unknown = readBakedComputerVersion(),
): string {
  // Single-executable builds replace an otherwise-absent identifier with the
  // package version. Runtime environment variables are not trusted as build
  // identity and cannot override a non-SEA package read.
  const baked = bakedVersion;
  if (typeof baked === "string" && baked.length > 0) return baked;
  const require = createRequire(moduleUrl);
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(candidate) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      // Try the next supported bundle depth.
    }
  }
  return "0.0.0-dev";
}

export const COMPUTER_VERSION = readComputerVersion();

export function readBundledDaemonVersion(
  bakedVersion: unknown = readBakedDaemonVersion(),
): string | undefined {
  // Native Computer SEA builds replace an otherwise-absent identifier with the
  // daemon package version. Keeping the value in Computer-owned code lets the
  // resident runner pass it explicitly even if daemon core stays a dynamic
  // package import instead of being rewritten by the Computer bundle pass.
  const baked = bakedVersion;
  return typeof baked === "string" && baked.length > 0 ? baked : undefined;
}

export const BUNDLED_DAEMON_VERSION = readBundledDaemonVersion();

export function readBundledCliVersion(
  bakedVersion: unknown = readBakedCliVersion(),
): string | undefined {
  const baked = bakedVersion;
  return typeof baked === "string" && baked.length > 0 ? baked : undefined;
}

export const BUNDLED_CLI_VERSION = readBundledCliVersion();
