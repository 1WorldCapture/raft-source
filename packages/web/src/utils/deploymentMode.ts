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
// Failure semantics: fetch error / non-OK / malformed body → "standard"
// (fail-open keeps official behavior when the endpoint is absent, e.g. an
// older server during rollout). The result is cached for the page lifetime —
// the deployment mode cannot change under a running page.
import { useSyncExternalStore } from "react";

import { RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";

export type DeploymentMode = "private" | "standard";

let cached: DeploymentMode | null = null;
let inflight: Promise<DeploymentMode> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Kick off (once) and await the mode fetch. */
export function ensureDeploymentMode(): Promise<DeploymentMode> {
  if (cached) return Promise.resolve(cached);
  inflight ??= (async (): Promise<DeploymentMode> => {
    try {
      const res = await fetch(`${RUNTIME_API_BASE}/deployment-info`, {
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as { deploymentMode?: unknown };
        if (body.deploymentMode === "private" || body.deploymentMode === "standard") {
          cached = body.deploymentMode;
        }
      }
    } catch {
      /* offline / older server without the endpoint → standard below */
    }
    if (cached === null) cached = "standard";
    inflight = null;
    notify();
    return cached;
  })();
  return inflight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // First interest starts the fetch; the snapshot flips from null once it
  // lands, re-rendering every subscriber through notify().
  void ensureDeploymentMode();
  return () => listeners.delete(listener);
}

function getSnapshot(): DeploymentMode | null {
  return cached;
}

/**
 * The deployment mode for command generation. `null` until the (single,
 * cached) fetch lands — callers treat null exactly like "standard" so the
 * pre-login install surfaces render immediately with official commands and
 * correct themselves only in a private deployment.
 */
export function useDeploymentMode(): DeploymentMode | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
