// Deployment mode for install-command generation (task #5/#6, private
// deployment phase 2).
//
// The web image is mode-agnostic — one image serves the official cloud and
// any self-hosted deployment — so "which install commands do we show" needs
// the server's RUNTIME answer, not a build-time bake. GET /api/deployment-info
// is that answer (it reads the canonical RAFT_DEPLOYMENT_MODE switch and,
// when private, carries the server-rendered download URLs — built from
// SERVER_URL only, never request headers).
//
// Deliberately NOT an artifacts probe: checking whether /downloads/computer/
// manifest.json exists would be inference; the switch is the source of truth.
//
// Resolution states (useDeploymentMode):
//   null          — still resolving (initial attempt or the single retry).
//                   Install-command surfaces must render NO command in this
//                   state: silently showing official commands on a private
//                   server is exactly the failure this task exists to remove
//                   (PM review round 1).
//   "unknown"     — the request failed twice. Commands render, with a notice
//                   telling intranet users to contact their administrator —
//                   never a silent fallback to official commands.
//   "private" | "standard" — resolved; cached for the page lifetime (the
//                   deployment mode cannot change under a running page).
import { useSyncExternalStore } from "react";

import { RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";

export type DeploymentMode = "private" | "standard";
export type DeploymentModeResolution = DeploymentMode | "unknown";

/** The server-rendered download URLs for a private deployment (task #6).
 *  Absent when not private, or when the server lacks a trusted origin or
 *  the artifact manifests — callers treat absence per-surface (notice /
 *  hidden command), never a guessed URL. */
export interface DeploymentDownloads {
  computerBase: string;
  cli?: string;
  daemon?: string;
}

/** Operator-configured replacements for official link surfaces (task #7). */
export interface DeploymentLinks {
  docsUrl?: string;
  legal?: { termsUrl?: string; privacyUrl?: string };
}

export interface DeploymentInfo {
  deploymentMode: DeploymentMode;
  downloads?: DeploymentDownloads;
  links?: DeploymentLinks;
}

let cached: DeploymentInfo | "unknown" | null = null;
let inflight: Promise<DeploymentInfo | "unknown"> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function parseDeploymentInfo(body: unknown): DeploymentInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const mode = (body as { deploymentMode?: unknown }).deploymentMode;
  if (mode !== "private" && mode !== "standard") return null;
  const info: DeploymentInfo = { deploymentMode: mode };
  if (mode === "private") {
    const downloads = (body as { downloads?: unknown }).downloads;
    if (typeof downloads === "object" && downloads !== null) {
      const { computerBase, cli, daemon } = downloads as Record<string, unknown>;
      if (typeof computerBase === "string" && computerBase) {
        const parsed: DeploymentDownloads = { computerBase };
        if (typeof cli === "string" && cli) parsed.cli = cli;
        if (typeof daemon === "string" && daemon) parsed.daemon = daemon;
        info.downloads = parsed;
      }
    }
    const links = (body as { links?: unknown }).links;
    if (typeof links === "object" && links !== null) {
      const parsed: DeploymentLinks = {};
      const { docsUrl, legal } = links as Record<string, unknown>;
      if (typeof docsUrl === "string" && docsUrl) parsed.docsUrl = docsUrl;
      if (typeof legal === "object" && legal !== null) {
        const { termsUrl, privacyUrl } = legal as Record<string, unknown>;
        const parsedLegal: NonNullable<DeploymentLinks["legal"]> = {};
        if (typeof termsUrl === "string" && termsUrl) parsedLegal.termsUrl = termsUrl;
        if (typeof privacyUrl === "string" && privacyUrl) parsedLegal.privacyUrl = privacyUrl;
        if (parsedLegal.termsUrl || parsedLegal.privacyUrl) parsed.legal = parsedLegal;
      }
      if (parsed.docsUrl || parsed.legal) info.links = parsed;
    }
  }
  return info;
}

async function fetchDeploymentModeOnce(): Promise<DeploymentInfo | null> {
  try {
    const res = await fetch(`${RUNTIME_API_BASE}/deployment-info`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      return parseDeploymentInfo(await res.json());
    }
  } catch {
    /* handled by the caller's retry policy */
  }
  return null;
}

/** Kick off (once) and await the mode resolution, retrying a failure once. */
export function ensureDeploymentMode(): Promise<DeploymentInfo | "unknown"> {
  if (cached) return Promise.resolve(cached);
  inflight ??= (async (): Promise<DeploymentInfo | "unknown"> => {
    // One retry: a transient blip on the very first page load should not
    // downgrade a private deployment to "unknown" for the whole session.
    const resolved = (await fetchDeploymentModeOnce()) ?? (await fetchDeploymentModeOnce());
    cached = resolved ?? "unknown";
    inflight = null;
    notify();
    return cached;
  })();
  return inflight;
}

/** Test seam: clear the page-lifetime cache between scenarios. */
export function __resetDeploymentModeForTests(): void {
  cached = null;
  inflight = null;
}

/** Test seam: pin the cache synchronously (no fetch) — the shared DOM test
 *  harness presets "standard" so legacy behavioral tests keep seeing install
 *  commands on first render; deployment-mode-specific tests reset or pin
 *  their own values. Accepts a bare mode or a full info object. */
export function __setDeploymentModeForTests(mode: DeploymentModeResolution | DeploymentInfo): void {
  cached = mode === "unknown" || typeof mode === "object"
    ? mode
    : { deploymentMode: mode };
  inflight = null;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // First interest starts the resolution; the snapshot flips from null once
  // it lands, re-rendering every subscriber through notify().
  void ensureDeploymentMode();
  return () => listeners.delete(listener);
}

function getInfoSnapshot(): DeploymentInfo | "unknown" | null {
  return cached;
}

function getModeSnapshot(): DeploymentModeResolution | null {
  if (cached === null || cached === "unknown") return cached;
  return cached.deploymentMode;
}

function getDownloadsSnapshot(): DeploymentDownloads | null {
  return cached && cached !== "unknown" ? cached.downloads ?? null : null;
}

/**
 * The deployment mode for command generation. `null` while resolving (the
 * initial attempt or the retry), "unknown" after both attempts failed.
 * Callers render NO install command for `null` and a notice for "unknown".
 */
export function useDeploymentMode(): DeploymentModeResolution | null {
  return useSyncExternalStore(subscribe, getModeSnapshot, getModeSnapshot);
}

/**
 * The server-rendered download URLs (private deployments only); null when
 * absent (standard / unknown / private without trusted URLs).
 */
export function useDeploymentDownloads(): DeploymentDownloads | null {
  return useSyncExternalStore(subscribe, getDownloadsSnapshot, getDownloadsSnapshot);
}

/**
 * Operator-configured official-link replacements (private deployments
 * only); null when absent.
 */
export function useDeploymentLinks(): DeploymentLinks | null {
  return useSyncExternalStore(subscribe, getLinksSnapshot, getLinksSnapshot);
}

function getLinksSnapshot(): DeploymentLinks | null {
  return cached && cached !== "unknown" ? cached.links ?? null : null;
}

/** Map a resolution to the ComputerCommandGuide display status. An absent
 *  value (callers that don't participate in deployment-mode gating) is
 *  "resolved" — the historical behavior. */
export function deploymentModeStatus(
  mode: DeploymentModeResolution | null | undefined,
): "loading" | "unknown" | "resolved" {
  if (mode === null) return "loading";
  if (mode === "unknown") return "unknown";
  return "resolved";
}
