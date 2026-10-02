// Runtime deployment configuration for the Computer onboarding commands.
//
// Contract v1 (私有部署配置契约 v1, "服务端配置与接口"): the browser must read
// `GET /api/deployment/computer-setup` (public; the server answers with
// Cache-Control: no-store) and generate onboarding commands from THAT runtime
// result. Falling back to official constants when the deployment config is
// absent is exactly the bug this contract fixes, so every non-ready outcome is
// surfaced as a visible error and command copy is disabled — never silently
// replaced. (The request must not set Cache-Control itself: it is a forbidden
// header name in browsers; freshness is the server's job.)

import api from "../api/client";

export const DEPLOYMENT_COMPUTER_SETUP_PATH = "/api/deployment/computer-setup";

/** The only schema this client understands; anything else is an explicit error. */
export const DEPLOYMENT_COMPUTER_SETUP_SCHEMA_VERSION = 1;

export type DeploymentReleaseBackend = "hands" | "manifest";

/**
 * `latest`, `alpha` (hands-backend QA channel served by the deployment) or
 * `pinned:<semver>`. Contract: the manifest backend has no alpha channel — a
 * manifest+alpha payload is contract-invalid and must surface as an explicit
 * error, never as latest wearing alpha's name.
 */
export type DeploymentInstallChannel = "latest" | "alpha" | `pinned:${string}`;

export interface DeploymentComputerSetupReady {
  schemaVersion: typeof DEPLOYMENT_COMPUTER_SETUP_SCHEMA_VERSION;
  status: "ready";
  serverUrl: string;
  releaseSource: {
    backend: DeploymentReleaseBackend;
    releaseBase: string;
    /** Required when backend is "hands"; unused by the manifest backend. */
    handsOrigin?: string;
  };
  installChannel: DeploymentInstallChannel;
}

export interface DeploymentComputerSetupNotReady {
  schemaVersion: typeof DEPLOYMENT_COMPUTER_SETUP_SCHEMA_VERSION;
  status: "missing" | "invalid";
  /** Names of the deployment variables the server found missing or invalid. */
  fields: string[];
}

export type DeploymentComputerSetupResponse =
  | DeploymentComputerSetupReady
  | DeploymentComputerSetupNotReady;

/**
 * What command-building surfaces consume. `unavailable` carries why the guide
 * must show a visible error instead of commands: the server refused (missing /
 * invalid deployment configuration), the payload did not match a known schema,
 * or the request itself failed.
 */
export type DeploymentComputerSetup =
  | { kind: "ready"; config: DeploymentComputerSetupReady }
  | {
      kind: "unavailable";
      reason: "missing" | "invalid" | "network" | "unsupported-schema";
      fields: string[];
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PINNED_CHANNEL_PATTERN = /^pinned:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isKnownInstallChannel(value: unknown): value is DeploymentInstallChannel {
  return value === "latest" || value === "alpha"
    || (typeof value === "string" && PINNED_CHANNEL_PATTERN.test(value));
}

/**
 * Structural validation of one `/api/deployment/computer-setup` payload.
 * Returns null when the payload does not match schemaVersion 1 at all, so the
 * caller can distinguish "the server spoke an unknown schema" from a declared
 * missing/invalid deployment configuration.
 */
export function validateDeploymentComputerSetupResponse(
  payload: unknown,
): DeploymentComputerSetupResponse | null {
  if (!isPlainObject(payload)) return null;
  if (payload.schemaVersion !== DEPLOYMENT_COMPUTER_SETUP_SCHEMA_VERSION) return null;

  const status = payload.status;
  if (status === "missing" || status === "invalid") {
    const fields = Array.isArray(payload.fields)
      ? payload.fields.filter((field): field is string => typeof field === "string")
      : [];
    return { schemaVersion: DEPLOYMENT_COMPUTER_SETUP_SCHEMA_VERSION, status, fields };
  }
  if (status !== "ready") return null;

  const serverUrl = typeof payload.serverUrl === "string" ? payload.serverUrl : "";
  if (!serverUrl) return null;
  const releaseSource = payload.releaseSource;
  if (!isPlainObject(releaseSource)) return null;
  const backend = releaseSource.backend;
  if (backend !== "hands" && backend !== "manifest") return null;
  const releaseBase = typeof releaseSource.releaseBase === "string" ? releaseSource.releaseBase : "";
  if (!releaseBase) return null;
  const handsOrigin = typeof releaseSource.handsOrigin === "string" ? releaseSource.handsOrigin : undefined;
  if (backend === "hands" && !handsOrigin) return null;
  if (!isKnownInstallChannel(payload.installChannel)) return null;
  // Contract: the manifest backend has no alpha channel. Reject the combination
  // explicitly (as an invalid deployment config) — never substitute latest.
  if (backend === "manifest" && payload.installChannel === "alpha") {
    return {
      schemaVersion: DEPLOYMENT_COMPUTER_SETUP_SCHEMA_VERSION,
      status: "invalid",
      fields: ["RAFT_COMPUTER_RELEASE_BACKEND", "installChannel"],
    };
  }

  return {
    schemaVersion: DEPLOYMENT_COMPUTER_SETUP_SCHEMA_VERSION,
    status: "ready",
    serverUrl,
    releaseSource:
      backend === "hands"
        ? { backend, releaseBase, handsOrigin }
        : { backend, releaseBase },
    installChannel: payload.installChannel,
  };
}

/**
 * Fetch the deployment config once. The endpoint is public; failures are never
 * thrown — every failure mode is returned as data so command surfaces can show
 * a visible error and disable copy instead of guessing.
 */
export async function fetchDeploymentComputerSetup(): Promise<DeploymentComputerSetup> {
  let payload: unknown;
  try {
    const response = await api.get(DEPLOYMENT_COMPUTER_SETUP_PATH);
    payload = response.data;
  } catch {
    return { kind: "unavailable", reason: "network", fields: [] };
  }

  const validated = validateDeploymentComputerSetupResponse(payload);
  if (!validated) {
    return { kind: "unavailable", reason: "unsupported-schema", fields: [] };
  }
  if (validated.status === "ready") {
    return { kind: "ready", config: validated };
  }
  return { kind: "unavailable", reason: validated.status, fields: validated.fields };
}
