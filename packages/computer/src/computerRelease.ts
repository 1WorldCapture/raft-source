import { clearClockTimeout, setClockTimeout, isPrivateDeploymentMode } from "@botiverse/raft-shared";
import { ComputerServiceError } from "./services/errors.js";
import { listServerAttachments, resolveAttachedServerSlug } from "./serverState.js";
import { canonicalizeServerUrl } from "./serverUrl.js";
import {
  parseReleaseBackend,
  readReleaseBackend,
  readReleaseBackendSync,
  RELEASE_BACKEND_ENV,
  type ReleaseBackend,
} from "./lib/releaseBackendState.js";

/** Public CDN root for published Computer SEA binaries. */
export const DEFAULT_UPGRADE_BASE_URL = "https://cdn.raft.build/computer";

/** Test/staging override for the Computer release source. */
export const UPGRADE_BASE_URL_ENV = "RAFT_COMPUTER_UPGRADE_BASE_URL";

export function resolveUpgradeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[UPGRADE_BASE_URL_ENV];
  return typeof override === "string" && override.trim().length > 0
    ? override.trim().replace(/\/+$/, "")
    : DEFAULT_UPGRADE_BASE_URL;
}

// --- server release backend (private deployment, phase 2 task #5) ----------

/** The resolved release authority + manifest base an upgrade check uses. */
export interface ResolvedUpgradeSource {
  readonly backend: ReleaseBackend;
  readonly baseUrl: string;
}

/**
 * Derive the manifest-tree base from the ORIGIN of the attached server(s).
 *
 * Fail-closed on ambiguity: a Computer upgrade swaps one binary for the
 * whole machine, so when attachments span multiple distinct origins the
 * resolution refuses to pick a side and demands an explicit
 * `RAFT_COMPUTER_UPGRADE_BASE_URL`.
 */
export async function resolveServerDownloadsBase(slockHome: string): Promise<string> {
  const attachments = await listServerAttachments(slockHome);
  const origins = [...new Set(attachments.map((a) => canonicalizeServerUrl(a.serverUrl)))];
  if (origins.length === 0) {
    throw new ComputerServiceError(
      "UPGRADE_SERVER_ORIGIN_ABSENT",
      `UPGRADE_SERVER_ORIGIN_ABSENT: the server release backend is selected but no server is attached under ${slockHome}; attach a server first or set ${UPGRADE_BASE_URL_ENV}`,
    );
  }
  if (origins.length > 1) {
    throw new ComputerServiceError(
      "UPGRADE_SERVER_ORIGIN_AMBIGUOUS",
      `UPGRADE_SERVER_ORIGIN_AMBIGUOUS: attached servers span multiple origins (${origins.join(", ")}); a Computer upgrade is one binary for the whole machine, so refusing to pick a side — set ${UPGRADE_BASE_URL_ENV} explicitly`,
    );
  }
  return `${origins[0]}/downloads/computer`;
}

/**
 * Full precedence chain for the upgrade source (task #5, PM-approved):
 *
 *   1. `RAFT_COMPUTER_UPGRADE_BASE_URL` — explicit base, the TRUE top
 *      override: it selects the manifest reader at that base whatever the
 *      configured backend. (Behavior fix: historically this env was
 *      silently ignored under the hands backend.)
 *   2. `RAFT_COMPUTER_RELEASE_BACKEND` env — explicit per-process choice.
 *   3. Installer-persisted `computer/release-backend` (written by
 *      install.sh's `RAFT_COMPUTER_INSTALL_BACKEND`) — the private-mode
 *      default that survives into launchd/systemd service contexts.
 *   4. Private-mode default (trigger B): no explicit selection + the
 *      canonical private switch + at least one attachment → `server`.
 *   5. Factory default `hands`.
 *
 * `server` derives its base from `resolveServerDownloadsBase` (fail-closed);
 * every other backend keeps the historical base resolution.
 */
export async function resolveUpgradeSourceForHome(
  slockHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedUpgradeSource> {
  const override = env[UPGRADE_BASE_URL_ENV]?.trim();
  if (override) {
    return { backend: "legacy-cdn", baseUrl: override.replace(/\/+$/, "") };
  }

  const envRaw = env[RELEASE_BACKEND_ENV]?.trim();
  if (envRaw && parseReleaseBackend(envRaw) === null) {
    throw new ComputerServiceError(
      "K_SOURCE_BACKEND_INVALID",
      `K_SOURCE_BACKEND_INVALID: ${RELEASE_BACKEND_ENV} must be "hands", "legacy-cdn" or "server"`,
    );
  }
  const selected = (envRaw ? parseReleaseBackend(envRaw) : null)
    ?? (await readReleaseBackend(slockHome));

  let backend: ReleaseBackend;
  if (selected) {
    backend = selected;
  } else if (
    isPrivateDeploymentMode(env.RAFT_DEPLOYMENT_MODE)
    && (await listServerAttachments(slockHome)).length > 0
  ) {
    backend = "server";
  } else {
    backend = "hands";
  }

  const baseUrl = backend === "server"
    ? await resolveServerDownloadsBase(slockHome)
    : resolveUpgradeBaseUrl(env);
  return { backend, baseUrl };
}

// --- private client context (task #7: telemetry + link neutralization) ----

/**
 * Whether THIS client machine operates in a private deployment context —
 * the same two triggers as the release backend (task #5): the canonical
 * env switch, or the installer-persisted server backend. Daemon and
 * Computer telemetry/link surfaces share this single predicate.
 */
export async function isPrivateClientContext(
  slockHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (isPrivateDeploymentMode(env.RAFT_DEPLOYMENT_MODE)) return true;
  return (await readReleaseBackend(slockHome)) === "server";
}

/** Synchronous twin for the CLI error presenter (cannot await). */
export function isPrivateClientContextSync(
  slockHome: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isPrivateDeploymentMode(env.RAFT_DEPLOYMENT_MODE)) return true;
  return readReleaseBackendSync(slockHome) === "server";
}

/**
 * The dashboard web origin OWNED BY this slug's attachment (private-neutral
 * deep links): the server and the web UI are same-origin in the standard
 * self-host topology, so the attachment's serverUrl IS the dashboard origin.
 * Per-slug — a multi-server Computer never borrows another attachment's
 * origin. null when the slug has no attachment.
 */
export async function resolveAttachmentWebOrigin(
  slockHome: string,
  serverSlug: string,
): Promise<string | null> {
  const attachment = await resolveAttachedServerSlug(slockHome, serverSlug);
  return attachment ? canonicalizeServerUrl(attachment.serverUrl) : null;
}

export type ComputerLatestVersionResolveResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: "publishing" | "network" };

/** Read the same latest pointer used by install.sh and K's ReleaseSource. */
export async function fetchCdnLatestVersionResult(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ComputerLatestVersionResolveResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/manifest.json`;
  const controller = new AbortController();
  const timeoutId = setClockTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, reason: response.status === 404 ? "publishing" : "network" };
    }
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.length > 0
      ? { ok: true, version: body.version }
      : { ok: false, reason: "publishing" };
  } catch {
    return { ok: false, reason: "network" };
  } finally {
    clearClockTimeout(timeoutId);
  }
}

export async function fetchCdnLatestVersion(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const result = await fetchCdnLatestVersionResult(baseUrl, fetchFn);
  return result.ok ? result.version : null;
}
