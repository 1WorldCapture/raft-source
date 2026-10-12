// Build provenance reader for the daemon (task #32).
//
// The daemon already reports its version, but version and provenance are
// different questions: `package.json` says 1.0.35 whether or not `dist/` was
// rebuilt from the commit you think it was. A stale `dist` whose package.json
// version still matches produced a mixed-version false reading during the 0.2.4
// observation, so the commit is baked in and reported alongside the version.
//
// The baked identifiers are replaced at build time by `packages/daemon/
// tsup.config.ts`. When the daemon runs from source (tsx/tests) or from a
// bundle built without git, they are absent and we fall back to an explicit
// `unknown` — never to a missing field, so "provenance unavailable" stays
// visible in output.

declare const __RAFT_DAEMON_COMMIT_SHA__: string | undefined;
declare const __RAFT_DAEMON_COMMIT_SHORT__: string | undefined;

/** Marker baked/returned when the commit could not be determined. */
export const UNKNOWN_COMMIT = "unknown";

export interface BuildProvenance {
  /** Full commit sha, or `unknown`. */
  sha: string;
  /** Short sha (12 chars) for logs and display, or `unknown`. */
  short: string;
  /** True only when a real sha was baked in. */
  known: boolean;
}

function bakedOrUnknown(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : UNKNOWN_COMMIT;
}

/**
 * Resolve the commit this daemon was built from.
 *
 * Arguments are injectable so the fallback path is unit-testable without
 * arranging a real build.
 */
export function readDaemonProvenance(
  bakedSha: unknown = typeof __RAFT_DAEMON_COMMIT_SHA__ === "string" ? __RAFT_DAEMON_COMMIT_SHA__ : undefined,
  bakedShort: unknown = typeof __RAFT_DAEMON_COMMIT_SHORT__ === "string" ? __RAFT_DAEMON_COMMIT_SHORT__ : undefined,
): BuildProvenance {
  const sha = bakedOrUnknown(bakedSha);
  const known = sha !== UNKNOWN_COMMIT;
  const short = bakedOrUnknown(bakedShort);
  return {
    sha,
    // A baked full sha without a baked short form still has a usable short form.
    short: short !== UNKNOWN_COMMIT ? short : (known ? sha.slice(0, 12) : UNKNOWN_COMMIT),
    known,
  };
}

/** `abc1234` / `unknown` — the form used in logs and `raft version`. */
export function formatCommitShort(provenance: BuildProvenance): string {
  return provenance.short;
}