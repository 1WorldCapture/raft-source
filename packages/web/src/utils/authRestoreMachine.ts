export type AuthRestoreState =
  | "booting"
  | "signed_out"
  | "restoring_auth"
  | "authenticated";

export type AuthRestoreEvent =
  | { type: "BOOT"; hasStoredSession: boolean }
  | { type: "LOGIN_SUCCEEDED" }
  | { type: "TOKENS_STORED" }
  | { type: "RESTORE_STARTED" }
  | { type: "RESTORE_SUCCEEDED" }
  | { type: "RESTORE_TRANSIENT_FAILURE"; hasStoredSession: boolean }
  | { type: "LOGOUT" };

export const MAX_AUTH_RESTORE_MS = 30_000;

// Last failure seen by the bootstrap restore loop (#desktop-session-restore
// task #1). The degraded UI shows it so the user can tell "the server said
// 502" from "nothing is reachable at all" — the two outages need different
// fixes (proxy/VPN vs credentials).
export interface LastRestoreError {
  kind: "network" | "http";
  status?: number;
  at: number;
}

/** Map an axios-shaped error onto the displayable LastRestoreError shape. */
export function describeRestoreError(err: unknown, now: number = Date.now()): LastRestoreError {
  const status = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  if (typeof status === "number") return { kind: "http", status, at: now };
  return { kind: "network", at: now };
}

export function deriveInitialAuthRestoreState(hasStoredSession: boolean): AuthRestoreState {
  return hasStoredSession ? "restoring_auth" : "booting";
}

export function nextAuthRestoreState(
  state: AuthRestoreState,
  event: AuthRestoreEvent,
): AuthRestoreState {
  switch (event.type) {
    case "BOOT":
      return event.hasStoredSession ? "restoring_auth" : "signed_out";
    case "LOGIN_SUCCEEDED":
      return "authenticated";
    case "TOKENS_STORED":
      return "restoring_auth";
    case "RESTORE_STARTED":
      return "restoring_auth";
    case "RESTORE_SUCCEEDED":
      return "authenticated";
    case "RESTORE_TRANSIENT_FAILURE":
      return event.hasStoredSession ? "restoring_auth" : "signed_out";
    case "LOGOUT":
      return "signed_out";
    default:
      return state;
  }
}

export function nextAuthRestoreStateAfterExternalTokenSync(
  state: AuthRestoreState,
): AuthRestoreState {
  if (state === "authenticated") return state;
  return nextAuthRestoreState(state, { type: "TOKENS_STORED" });
}

export function shouldRetryAuthRestore(params: {
  initialized: boolean;
  restoreState: AuthRestoreState;
  hasStoredSession: boolean;
}): boolean {
  return params.initialized && params.restoreState === "restoring_auth" && params.hasStoredSession;
}

export function hasAuthRestoreTimedOut(params: {
  initialized: boolean;
  restoreState: AuthRestoreState;
  hasStoredSession: boolean;
  elapsedMs: number;
  maxElapsedMs?: number;
}): boolean {
  if (!shouldRetryAuthRestore(params)) return false;
  return params.elapsedMs >= (params.maxElapsedMs ?? MAX_AUTH_RESTORE_MS);
}

export function getAuthBootstrapView(params: {
  initialized: boolean;
  restoreState: AuthRestoreState;
}): "loading" | "restoring" | "ready" | "signed_out" {
  if (!params.initialized || params.restoreState === "booting") return "loading";
  if (params.restoreState === "restoring_auth") return "restoring";
  if (params.restoreState === "authenticated") return "ready";
  return "signed_out";
}
