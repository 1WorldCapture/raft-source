// Detects the backend's explicit "this capability is not enabled on this
// server" rejection — 501 { code: "feature_not_implemented" } — so panels can
// render a truthful feature-not-enabled state instead of a retryable failure
// banner. The Go server serves this contract from authenticated, scope-checked
// deferred endpoints (agent skills, reminders, office overview, /socket.io/):
// callers that pass auth and authorization receive the machine-readable 501.
//
// A generic 404 { error: "Not found" } is deliberately NOT matched, on either
// backend. A 404 is ambiguous — it can be a genuinely missing resource, a
// proxy misroute, or a typo'd path — so it must keep surfacing as a real
// error. Only the explicit, code-marked 501 says "retrying cannot succeed
// because the capability is absent". Do not loosen this to bare status checks:
// broadly suppressing real errors is exactly the regression this guard exists
// to prevent (401/403 auth, 5xx, network errors, and semantic 404s such as
// { error: "Agent not found" } must all keep their error paths).

type UnavailableCandidate = {
  response?: {
    status?: unknown;
    data?: unknown;
  };
};

export function isServerFeatureUnavailableResponse(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { response } = err as UnavailableCandidate;
  if (!response || typeof response !== "object") return false;
  const { status, data } = response as { status?: unknown; data?: unknown };
  if (status !== 501) return false;
  return (data as { code?: unknown } | null | undefined)?.code === "feature_not_implemented";
}
