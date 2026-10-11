import { createApiTest } from "./test/integration/apiTest.js";
/**
 * Default freshness policy for the authenticated API surface (upstream
 * 1.21.2 security port): every /api and /internal response carries
 * `Cache-Control: private, no-store` unless the route overrides it with an
 * intentional policy of its own (immutable attachment payloads, OIDC
 * discovery, integration assets). The middleware runs before auth, so even
 * rejected requests are covered — a shared cache must never replay a stale
 * authenticated body, and a 401/403 must not become a cacheable signal.
 */

import assert from "node:assert/strict";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("/api responses carry the no-store default (even unauthenticated 401s)", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/servers`, {
    headers: { "X-Server-Id": "00000000-0000-0000-0000-000000000000" },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("/internal responses carry the no-store default (even unauthenticated 401s)", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("non-API surfaces are not touched by the API freshness policy", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/`);
  assert.equal(res.headers.get("cache-control"), null);
});
