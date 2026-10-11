/**
 * Shared path-safety guards for agent migration (task #25).
 *
 * An agent id becomes a directory name here, so a name like "." or ".." must never reach `path.join`: those
 * resolve to the parent itself, which for the agents root means the whole machine's agent workspaces.
 */
import path from "node:path";

/**
 * Reject anything that is not exactly one literal path segment. This is deliberately about shape, not format:
 * migration bundles legitimately carry non-UUID agent ids (`agent-1`, ...), so a UUID check would be wrong here.
 * The workspace delete/reset paths apply the stricter containment check in `resolveWorkspaceDirectoryPath`.
 */
export function assertSafePathSegment(value: string, errorCode: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(errorCode);
  }
}

/**
 * Reject `target` unless it resolves to exactly one path segment below `root` — i.e. its resolved parent is
 * `root` itself. Same containment invariant as the workspace delete (#335) and reset (#24) paths, kept local so
 * it does not depend on every caller having validated the id shape first.
 */
export function assertDirectChildOf(root: string, target: string, errorCode: string): void {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (absoluteTarget === absoluteRoot || path.dirname(absoluteTarget) !== absoluteRoot) {
    throw new Error(errorCode);
  }
}