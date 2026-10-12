// Build-time commit provenance.
//
// Why this exists (task #32): neither `package.json`'s version nor the trace's
// `daemon_version` can prove WHICH commit a `dist/` was built from. During the
// 0.2.4 duplicate-delivery observation, `packages/computer/dist` turned out to
// be a stale build whose package.json version still matched the release — a
// matching version number is not build provenance. A build that records its own
// commit makes that class of mistake detectable instead of silent.
//
// Contract:
//   - NEVER throws. A build without a git checkout (CI tarball, vendored copy,
//     `npm pack`) must still succeed with an explicit `unknown` marker, so the
//     absence of provenance is visible in output rather than inferred from a
//     missing field.
//   - `RAFT_BUILD_COMMIT` wins when set, so release tooling can stamp provenance
//     explicitly instead of depending on git being present.

import { execFileSync } from "node:child_process";

/** Baked value used when the commit genuinely cannot be determined. */
export const UNKNOWN_COMMIT = "unknown";

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const SHORT_SHA_LENGTH = 12;

function defaultRunGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Resolve the commit this build is made from.
 *
 * @returns {{sha: string, short: string, source: "env" | "git" | "unknown"}}
 */
export function resolveBuildCommit(options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    runGit = defaultRunGit,
  } = options;

  const fromEnv = typeof env.RAFT_BUILD_COMMIT === "string" ? env.RAFT_BUILD_COMMIT.trim() : "";
  if (fromEnv.length > 0) return normalizeCommit(fromEnv, "env");

  try {
    const head = runGit(["rev-parse", "HEAD"], cwd);
    const normalized = normalizeCommit(head, "git");
    if (normalized.source === "git") return normalized;
  } catch {
    // No git, not a repository, or git is unavailable — fall through to the
    // explicit unknown marker rather than failing the build.
  }
  return { sha: UNKNOWN_COMMIT, short: UNKNOWN_COMMIT, source: "unknown" };
}

/**
 * Accept a full or abbreviated sha, or any explicit stamp. We do NOT require
 * hex so release tooling may stamp a non-sha identifier; anything blank or
 * unusable collapses to the unknown marker.
 */
function normalizeCommit(value, source) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) return { sha: UNKNOWN_COMMIT, short: UNKNOWN_COMMIT, source: "unknown" };
  if (source === "git" && !SHA_PATTERN.test(trimmed)) {
    // `git rev-parse HEAD` returning something that is not a sha means we are
    // not looking at the commit we think we are; do not present it as one.
    return { sha: UNKNOWN_COMMIT, short: UNKNOWN_COMMIT, source: "unknown" };
  }
  const short = trimmed.length > SHORT_SHA_LENGTH ? trimmed.slice(0, SHORT_SHA_LENGTH) : trimmed;
  return { sha: trimmed, short, source };
}

/**
 * esbuild/tsup `define` map baking the commit into a bundle, e.g.
 * `buildCommitDefines("RAFT_DAEMON")` yields
 * `__RAFT_DAEMON_COMMIT_SHA__` / `__RAFT_DAEMON_COMMIT_SHORT__`.
 */
export function buildCommitDefines(prefix, options = {}) {
  const { sha, short } = resolveBuildCommit(options);
  return {
    [`__${prefix}_COMMIT_SHA__`]: JSON.stringify(sha),
    [`__${prefix}_COMMIT_SHORT__`]: JSON.stringify(short),
  };
}