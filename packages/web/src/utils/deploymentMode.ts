// Deployment mode for install-command generation (task #5, private
// deployment phase 2).
//
// The web image is mode-agnostic — one image serves the official cloud and
// any self-hosted deployment — so "which install commands do we show" needs
// the server's RUNTIME answer, not a build-time bake. GET /api/deployment-info
// is that answer (it reads the canonical RAFT_DEPLOYMENT_MODE switch).
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

let cached: DeploymentModeResolution | null = null;
let inflight: Promise<DeploymentModeResolution> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

async function fetchDeploymentModeOnce(): Promise<DeploymentMode | null> {
  try {
    const res = await fetch(`${RUNTIME_API_BASE}/deployment-info`, {
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as { deploymentMode?: unknown };
      if (body.deploymentMode === "private" || body.deploymentMode === "standard") {
        return body.deploymentMode;
      }
    }
  } catch {
    /* handled by the caller's retry policy */
  }
  return null;
}

/** Kick off (once) and await the mode resolution, retrying a failure once. */
export function ensureDeploymentMode(): Promise<DeploymentModeResolution> {
  if (cached) return Promise.resolve(cached);
  inflight ??= (async (): Promise<DeploymentModeResolution> => {
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

/** Test seams: control the page-lifetime cache between scenarios. */
export function __resetDeploymentModeForTests(): void {
  cached = null;
  inflight = null;
}

/** Test seam: pin the cache synchronously (no fetch) — the shared DOM test
 *  harness presets "standard" so legacy behavioral tests keep seeing install
 *  commands on first render; deployment-mode-specific tests reset or pin
 *  their own values. */
export function __setDeploymentModeForTests(mode: DeploymentModeResolution): void {
  cached = mode;
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

function getSnapshot(): DeploymentModeResolution | null {
  return cached;
}

/**
 * The deployment mode for command generation. `null` while resolving (the
 * initial attempt or the retry), "unknown" after both attempts failed.
 * Callers render NO install command for `null` and a notice for "unknown".
 */
export function useDeploymentMode(): DeploymentModeResolution | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
