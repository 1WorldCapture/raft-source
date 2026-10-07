export type ReconnectAuthRefreshAction =
  | { type: "update-auth-only"; auth: Record<string, unknown> }
  | { type: "trigger-refresh-and-update"; reason: "expired" | "near-expiry" | "no-exp-claim" }
  | { type: "skip"; reason: "no-token" };

export interface PlanReconnectAuthRefreshParams {
  latestAccessToken: string | null;
  freshAuth: Record<string, unknown>;
  parseTokenExp: (token: string) => number | null;
  now: number;
  refreshSoonThresholdMs?: number;
}

const DEFAULT_REFRESH_SOON_THRESHOLD_MS = 60_000;

/**
 * Same decision as the web client (`packages/web/src/utils/socketReconnectAuthRefresh.ts`):
 * engine.io retries reuse the cached socket auth object, so a reconnect must
 * either copy the latest token or refresh before the next handshake.
 */
export function planReconnectAuthRefresh(
  params: PlanReconnectAuthRefreshParams,
): ReconnectAuthRefreshAction {
  const threshold = params.refreshSoonThresholdMs ?? DEFAULT_REFRESH_SOON_THRESHOLD_MS;
  if (!params.latestAccessToken) return { type: "skip", reason: "no-token" };

  const exp = params.parseTokenExp(params.latestAccessToken);
  if (exp === null) return { type: "trigger-refresh-and-update", reason: "no-exp-claim" };

  const msUntilExpiry = exp - params.now;
  if (msUntilExpiry <= 0) return { type: "trigger-refresh-and-update", reason: "expired" };
  if (msUntilExpiry < threshold) return { type: "trigger-refresh-and-update", reason: "near-expiry" };
  return { type: "update-auth-only", auth: params.freshAuth };
}

export function parseAccessTokenExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload: unknown = JSON.parse(globalThis.atob(padded));
    if (typeof payload !== "object" || payload === null) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== "number") return null;
    return exp * 1000;
  } catch {
    return null;
  }
}
