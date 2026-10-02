import { useEffect, useState } from "react";
import type { DeploymentComputerSetup } from "../utils/deploymentComputerSetup";
import { fetchDeploymentComputerSetup } from "../utils/deploymentComputerSetup";

// Dedupe concurrent mounts (several onboarding/machine surfaces can need the
// same config in one pass) without caching across the session: the endpoint is
// no-store and later mounts refetch, so a deployment fix shows up on the next
// visit instead of being pinned by the browser.
let inFlight: Promise<DeploymentComputerSetup> | null = null;
function fetchDeploymentComputerSetupDeduped(): Promise<DeploymentComputerSetup> {
  if (!inFlight) {
    inFlight = fetchDeploymentComputerSetup().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export interface DeploymentComputerSetupState {
  /** null while the first request is in flight. */
  setup: DeploymentComputerSetup | null;
  loading: boolean;
}

/**
 * Runtime deployment configuration for Computer onboarding commands
 * (contract v1). Command surfaces must render from this result and show a
 * visible, copy-disabled error state when it is not ready — never fall back
 * to official constants.
 */
export function useDeploymentComputerSetup(): DeploymentComputerSetupState {
  const [setup, setSetup] = useState<DeploymentComputerSetup | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchDeploymentComputerSetupDeduped().then((result) => {
      if (cancelled) return;
      setSetup(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { setup, loading };
}
