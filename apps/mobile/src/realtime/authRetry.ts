const MAX_AUTH_RETRY_MS = 15_000;

/** Backoff after a refresh failed because the network was down. Caps under the 30s recovery window. */
export function authRetryDelayMs(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt));
  return Math.min(MAX_AUTH_RETRY_MS, 1000 * 2 ** step);
}

export function authFailureAction(input: {
  refreshOk: boolean;
  hasAccessToken: boolean;
  alreadyRefreshed: boolean;
}): "reconnect" | "retry-later" | "stop" {
  if (!input.hasAccessToken) return "stop";
  if (!input.refreshOk) return "retry-later";
  if (input.alreadyRefreshed) return "stop";
  return "reconnect";
}
