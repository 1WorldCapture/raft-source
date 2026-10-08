import assert from "node:assert/strict";
import test from "node:test";
import { isServerFeatureUnavailableResponse } from "../src/utils/serverFeatureAvailability";

function httpError(status: number, data: unknown) {
  // Shape mirrors what the axios response interceptor rejects with.
  return { response: { status, data } };
}

test("explicit 501 feature_not_implemented is unavailable", () => {
  // Go deferred endpoints (deferred_ui_routes.go / routes.go notImplemented):
  // auth + scope + authority checks pass, then the machine-readable 501.
  assert.equal(
    isServerFeatureUnavailableResponse(
      httpError(501, { error: "Agent skills are not enabled in this server stage", code: "feature_not_implemented" }),
    ),
    true,
  );
  assert.equal(
    isServerFeatureUnavailableResponse(
      httpError(501, { error: "Reminders are not enabled in this server stage", code: "feature_not_implemented" }),
    ),
    true,
  );
  assert.equal(
    isServerFeatureUnavailableResponse(
      httpError(501, { error: "Office overview is not enabled in this server stage", code: "feature_not_implemented" }),
    ),
    true,
  );
  assert.equal(
    isServerFeatureUnavailableResponse(
      httpError(501, { error: "Socket.IO realtime transport is not implemented in the account phase", code: "feature_not_implemented" }),
    ),
    true,
  );
});

test("501 without the feature_not_implemented code is a real error", () => {
  assert.equal(isServerFeatureUnavailableResponse(httpError(501, { error: "weird gateway" })), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(501, { code: "not_implemented" })), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(501, null)), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(501, "Not Implemented")), false);
});

test("generic 404 Not found stays a real error on every backend shape", () => {
  // A 404 is ambiguous (missing resource / proxy misroute / typo'd path) and
  // must never be swallowed into a not-enabled state — including the exact
  // bodies the Go and TS catch-alls produce.
  assert.equal(isServerFeatureUnavailableResponse(httpError(404, { error: "Not found" })), false);
  assert.equal(
    isServerFeatureUnavailableResponse(httpError(404, { error: "Not found", code: "not_found", path: "/api/reminders" })),
    false,
  );
});

test("semantic 404s and all other statuses are real errors", () => {
  // Go deferred endpoints answer these BEFORE the 501; they must surface.
  assert.equal(isServerFeatureUnavailableResponse(httpError(404, { error: "Agent not found" })), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(401, { error: "Unauthorized" })), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(403, { error: "You do not have permission to view this agent's skills" })), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(500, { error: "Failed to get agent" })), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(503, { error: "unavailable" })), false);
  assert.equal(isServerFeatureUnavailableResponse(httpError(400, { error: "Invalid reminder owner" })), false);
  // No response object (network failure / cancelled request).
  assert.equal(isServerFeatureUnavailableResponse(new Error("Network Error")), false);
  assert.equal(isServerFeatureUnavailableResponse({ message: "timeout" }), false);
  assert.equal(isServerFeatureUnavailableResponse(null), false);
  assert.equal(isServerFeatureUnavailableResponse(undefined), false);
});
