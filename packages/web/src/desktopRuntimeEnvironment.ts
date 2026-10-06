export type DesktopRuntimeEnvironment = Readonly<{
  environmentId: "production" | "staging" | "server";
  generation: number;
  frontendOrigin: string;
  apiOrigin: string;
  socketOrigin: string;
  updateAuthority: "productionHands" | "none";
}>;

export const INVALID_DESKTOP_RUNTIME_ENVIRONMENT = "INVALID_DESKTOP_RUNTIME_ENVIRONMENT" as const;

export class InvalidDesktopRuntimeEnvironmentError extends Error {
  readonly code = INVALID_DESKTOP_RUNTIME_ENVIRONMENT;

  constructor() {
    super("Invalid Desktop runtime environment");
    this.name = "InvalidDesktopRuntimeEnvironmentError";
  }
}

/** environmentId values backed by a fixed preset (the runtime-configured
 *  "server" environment has none — its origins are per-deployment). */
export type PresetEnvironmentId = Exclude<DesktopRuntimeEnvironment["environmentId"], "server">;

type DesktopRuntimeEnvironmentPreset = Readonly<Omit<DesktopRuntimeEnvironment, "environmentId" | "generation">>;

export const DESKTOP_RUNTIME_ENVIRONMENT_PRESETS: Readonly<Record<PresetEnvironmentId, DesktopRuntimeEnvironmentPreset>> = Object.freeze({
  production: Object.freeze({
    frontendOrigin: "https://app.raft.build",
    apiOrigin: "https://api.raft.build",
    socketOrigin: "https://api.raft.build",
    updateAuthority: "productionHands",
  }),
  staging: Object.freeze({
    frontendOrigin: "https://raft-app-staging.botiverse.dev",
    apiOrigin: "https://api-aws-staging.botiverse.dev",
    socketOrigin: "https://api-aws-staging.botiverse.dev",
    updateAuthority: "none",
  }),
});

type EnvironmentHost = {
  __RAFT_DESKTOP_ENVIRONMENT__?: unknown;
  __TAURI_INTERNALS__?: { invoke?: unknown };
};

export function hasDesktopBridge(host: EnvironmentHost = globalThis as EnvironmentHost): boolean {
  return typeof host.__TAURI_INTERNALS__?.invoke === "function";
}

function origin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// ── Runtime-configured server environment (Electron desktop, phase 3-1) ──────
//
// The Electron shell injects the user-configured private server as a MINIMAL
// three-key shape — exactly {apiOrigin, socketOrigin, generation}, nothing
// else (PM review: preload exposes the least it can). The remaining fields
// are derived, not injected: environmentId "server", frontendOrigin follows
// apiOrigin (a self-hosted deployment serves its web frontend from the same
// origin), and updateAuthority is "none" (no official Hands feed governs a
// private deployment; private app updates are a separate later task).
//
// Unlike the preset environments, the origin is NOT compared against a fixed
// allowlist: it must merely be a structurally valid https root origin. The
// value crosses no trust boundary that the preset lock defends — the Tauri
// handshake only negotiates privileges for preset environments, and in the
// Electron app the injection comes from our own sandboxed preload over
// additionalArguments (page scripts cannot forge it into the preload world;
// a fully compromised renderer already holds its tokens in memory, so
// steering fetch adds no new capability).

const SERVER_ENVIRONMENT_KEYS = "apiOrigin,generation,socketOrigin";

function readServerRuntimeEnvironment(
  record: Record<string, unknown>,
): DesktopRuntimeEnvironment | null {
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1) return null;
  const apiOrigin = origin(record.apiOrigin);
  const socketOrigin = origin(record.socketOrigin);
  if (!apiOrigin || !socketOrigin) return null;
  return Object.freeze({
    environmentId: "server",
    generation: record.generation as number,
    frontendOrigin: apiOrigin,
    apiOrigin,
    socketOrigin,
    updateAuthority: "none",
  });
}

export function readDesktopRuntimeEnvironment(
  host: EnvironmentHost = globalThis as EnvironmentHost,
): DesktopRuntimeEnvironment | null {
  const value = host.__RAFT_DESKTOP_ENVIRONMENT__;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys === SERVER_ENVIRONMENT_KEYS) return readServerRuntimeEnvironment(record);
  if (keys !== "apiOrigin,environmentId,frontendOrigin,generation,socketOrigin,updateAuthority") return null;
  if (record.environmentId !== "production" && record.environmentId !== "staging") return null;
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1) return null;
  const frontendOrigin = origin(record.frontendOrigin);
  const apiOrigin = origin(record.apiOrigin);
  const socketOrigin = origin(record.socketOrigin);
  if (!frontendOrigin || !apiOrigin || !socketOrigin) return null;
  const expected = DESKTOP_RUNTIME_ENVIRONMENT_PRESETS[record.environmentId];
  if (
    frontendOrigin !== expected.frontendOrigin ||
    apiOrigin !== expected.apiOrigin ||
    socketOrigin !== expected.socketOrigin ||
    record.updateAuthority !== expected.updateAuthority
  ) return null;
  return Object.freeze({
    environmentId: record.environmentId,
    generation: record.generation as number,
    frontendOrigin,
    apiOrigin,
    socketOrigin,
    updateAuthority: expected.updateAuthority,
  });
}

const compiledApiOrigin = typeof import.meta.env?.VITE_API_URL === "string"
  ? import.meta.env.VITE_API_URL.replace(/\/$/, "")
  : "";
export const DESKTOP_RUNTIME_ENVIRONMENT = readDesktopRuntimeEnvironment();
type GenerationStorage = Pick<Storage, "getItem" | "setItem" | "clear">;
type RuntimeCacheStorage = Pick<CacheStorage, "keys" | "delete">;

export function applyDesktopEnvironmentGeneration(
  environment: DesktopRuntimeEnvironment | null,
  storage: GenerationStorage | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
  cacheStorage: RuntimeCacheStorage | undefined = typeof caches === "undefined" ? undefined : caches,
): boolean {
  // Node exposes a HOLLOW localStorage object (no getItem) unless
  // --experimental-webstorage is on — treat any unusable storage as absent
  // rather than crashing at module load.
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.clear !== "function") {
    return false;
  }
  // The marker keys the session identity to BOTH the API origin and the
  // native generation (PM review, phase 3-1): generation alone cannot
  // distinguish two env-configured origins (both inject generation 1), and
  // origin alone cannot force re-auth when the user returns to a previously
  // used environment. Legacy values (a bare generation number, written by
  // pre-composite builds) never contain "#".
  const generationKey = "raft_desktop_environment_generation";
  const marker = environment ? `${environment.apiOrigin}#${environment.generation}` : null;
  const stored = storage.getItem(generationKey);

  const matches =
    stored === marker ||
    // Legacy migration: a bare generation number from an older build counts
    // as a match for preset environments only (their origin never varies;
    // "server" environments are new and always write composite markers).
    (environment !== null && environment.environmentId !== "server" && stored !== null && !stored.includes("#") && stored === String(environment.generation));

  if (marker !== null && matches) return false;
  if (marker === null && stored === null) return false;

  // Environment switches are intentionally destructive. Distinct origins
  // isolate prod/staging; the composite marker additionally forces fresh
  // auth whenever the user returns to a previously used environment.
  //
  // marker === null (no injected environment — the compiled/official
  // default): a lingering marker proves a PREVIOUS boot ran under an
  // injected environment; clear once and leave no marker, so private-server
  // tokens never ride into the official backend (and vice versa). Builds
  // that never injected keep `stored === null` and are never touched.
  storage.clear();
  if (marker !== null) storage.setItem(generationKey, marker);
  if (cacheStorage) {
    void cacheStorage.keys().then((keys) => Promise.all(keys.map((key) => cacheStorage.delete(key))));
  }
  return true;
}
applyDesktopEnvironmentGeneration(DESKTOP_RUNTIME_ENVIRONMENT);

export function deriveRuntimeEndpoints(
  environment: DesktopRuntimeEnvironment | null,
  compiledOrigin = compiledApiOrigin,
  pageOrigin = globalThis.location?.origin || "",
  desktopBridgePresent = hasDesktopBridge(),
) {
  if (desktopBridgePresent && !environment) {
    return Object.freeze({
      apiOrigin: "",
      apiBase: "/api",
      socketOrigin: "/",
      desktopRuntimeError: INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
    });
  }

  const apiOrigin = environment?.apiOrigin || compiledOrigin || pageOrigin;
  return Object.freeze({
    apiOrigin,
    apiBase: apiOrigin ? `${apiOrigin.replace(/\/$/, "")}/api` : "/api",
    socketOrigin: environment?.socketOrigin || compiledOrigin || "/",
    desktopRuntimeError: null,
  });
}

const runtimeEndpoints = deriveRuntimeEndpoints(DESKTOP_RUNTIME_ENVIRONMENT);
export const RUNTIME_API_BASE = runtimeEndpoints.apiBase;

// Display form of the API base for the degraded-restore card
// (#desktop-session-restore task #1 review): on the web build RUNTIME_API_BASE
// is the RELATIVE "/api" (compiled origin and page origin are the same), so
// showing it raw would render a bare "/api". Resolve it against the page
// origin; an already-absolute desktop base passes through unchanged.
export function absoluteApiBase(apiBase: string, pageOrigin: string): string {
  return new URL(apiBase, pageOrigin).toString();
}
export const RUNTIME_API_ORIGIN = runtimeEndpoints.apiOrigin;
export const RUNTIME_SOCKET_ORIGIN = runtimeEndpoints.socketOrigin;
export const RUNTIME_DESKTOP_ENVIRONMENT_ERROR = runtimeEndpoints.desktopRuntimeError;

export function assertValidDesktopRuntimeEnvironment(
  error: typeof RUNTIME_DESKTOP_ENVIRONMENT_ERROR = RUNTIME_DESKTOP_ENVIRONMENT_ERROR,
): void {
  if (error) throw new InvalidDesktopRuntimeEnvironmentError();
}
