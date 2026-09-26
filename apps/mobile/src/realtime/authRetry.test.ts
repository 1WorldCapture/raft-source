import assert from "node:assert/strict";
import test from "node:test";
import { authFailureAction, authRetryDelayMs } from "./authRetry.ts";

test("authRetryDelayMs backs off and stays inside 15 seconds", () => {
  assert.equal(authRetryDelayMs(0), 1000);
  assert.equal(authRetryDelayMs(1), 2000);
  assert.equal(authRetryDelayMs(2), 4000);
  assert.equal(authRetryDelayMs(8), 15_000);
});

test("authFailureAction retries a network error and stops a rejected refresh", () => {
  assert.equal(authFailureAction({ refreshOk: false, hasAccessToken: true, alreadyRefreshed: false }), "retry-later");
  assert.equal(authFailureAction({ refreshOk: true, hasAccessToken: true, alreadyRefreshed: false }), "reconnect");
  assert.equal(authFailureAction({ refreshOk: true, hasAccessToken: true, alreadyRefreshed: true }), "stop");
  assert.equal(authFailureAction({ refreshOk: false, hasAccessToken: false, alreadyRefreshed: false }), "stop");
});
