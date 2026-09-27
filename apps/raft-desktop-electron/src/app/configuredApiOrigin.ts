// Runtime view of the build-time API configuration (see ../../buildConfig.mjs).
// The bundler replaces __RAFT_DESKTOP_API_ORIGIN__ with the configured origin;
// in unbundled contexts (tests, tsx) the identifier is undefined and the
// official default applies — the same fallback shape packages/computer's
// version.ts uses for its baked identifiers.

declare const __RAFT_DESKTOP_API_ORIGIN__: string | undefined;

// `typeof` keeps the undeclared identifier safe in unbundled contexts (tests,
// tsx): it evaluates to "undefined" instead of throwing, exactly like the
// baked-version readers in packages/computer/src/version.ts.
function readBakedApiOrigin(): unknown {
  return typeof __RAFT_DESKTOP_API_ORIGIN__ === "string" ? __RAFT_DESKTOP_API_ORIGIN__ : undefined;
}

export const OFFICIAL_API_ORIGINS: ReadonlySet<string> = new Set([
  "https://api.raft.build",
  "https://api-aws-staging.botiverse.dev",
]);

export const DEFAULT_API_ORIGIN = "https://api.raft.build";

export function readConfiguredApiOrigin(baked: unknown = readBakedApiOrigin()): string {
  return typeof baked === "string" && baked.length > 0 ? baked : DEFAULT_API_ORIGIN;
}

export const CONFIGURED_API_ORIGIN: string = readConfiguredApiOrigin();

/**
 * True when this build talks to an official backend (including stock builds
 * with nothing configured). Self-hosted builds return false: they must widen
 * the renderer CSP and the main-process CORS/OAuth allowlists to exactly the
 * configured origin, and must not auto-update (the update feed publishes the
 * official app, which would replace a self-hosted build with an official one).
 */
export function isOfficialApiBuild(configuredOrigin: string = CONFIGURED_API_ORIGIN): boolean {
  return OFFICIAL_API_ORIGINS.has(configuredOrigin);
}

/**
 * The origins the main-process CORS bridge rewrites responses for: the two
 * official backends plus — for self-hosted builds only — the configured
 * origin, exactly. Matching downstream is by parsed origin, so look-alike
 * hosts (e.g. https://api.raft.build.evil.com) stay rejected.
 */
export function buildApiOrigins(configuredOrigin: string = CONFIGURED_API_ORIGIN): ReadonlySet<string> {
  const origins = new Set<string>(OFFICIAL_API_ORIGINS);
  if (!isOfficialApiBuild(configuredOrigin)) origins.add(configuredOrigin);
  return origins;
}
