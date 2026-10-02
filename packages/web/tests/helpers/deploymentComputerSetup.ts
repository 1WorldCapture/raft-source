// Test helper for the contract-v1 deployment config endpoint.
//
// Behavioral tests render command surfaces that now fetch
// `GET /api/deployment/computer-setup` at runtime. domSetup installs the
// DEFAULT_READY stub so surfaces behave as "ready" unless a test overrides
// `api.get` itself (the aboutFeedback-style pattern) to exercise locked
// states: missing/invalid config, network failure, unknown schema.
import api from "../../src/api/client";
import type { DeploymentComputerSetupReady } from "../../src/utils/deploymentComputerSetup";

export const DEPLOYMENT_SETUP_PATH = "/deployment/computer-setup";

export const DEFAULT_READY: DeploymentComputerSetupReady = {
  schemaVersion: 1,
  status: "ready",
  serverUrl: "https://api.raft.build",
  releaseSource: {
    backend: "manifest",
    releaseBase: "https://cdn.raft.build/computer",
  },
  installChannel: "latest",
};

type ApiGet = typeof api.get;

let originalGet: ApiGet | null = null;

/** Install the default ready stub; called once from domSetup. */
export function installDefaultDeploymentStub(): void {
  if (originalGet !== null) return;
  originalGet = api.get;
  api.get = (async (url: string, ...rest: unknown[]) => {
    if (typeof url === "string" && url.startsWith(DEPLOYMENT_SETUP_PATH)) {
      return { data: DEFAULT_READY };
    }
    return (originalGet as ApiGet)(url, ...rest);
  }) as ApiGet;
}

/** Restore whatever api.get was installed before the default stub. */
export function restoreDefaultDeploymentStub(): void {
  if (originalGet !== null) {
    api.get = originalGet;
    originalGet = null;
  }
}
