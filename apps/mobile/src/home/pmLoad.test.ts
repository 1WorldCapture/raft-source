import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../api/client.ts";
import {
  SESSION_READY_WAIT_MS,
  pmLoadErrorMessage,
  shouldStopWaitingForSession,
} from "./pmLoad.ts";

const loadFailed = "Couldn't load channels";

test("the session wait matches the five second timer", () => {
  assert.equal(SESSION_READY_WAIT_MS, 5_000);
  assert.equal(shouldStopWaitingForSession(4_999, false, false), false);
  assert.equal(shouldStopWaitingForSession(5_000, false, false), true);
  assert.equal(shouldStopWaitingForSession(5_000, true, false), true);
  assert.equal(shouldStopWaitingForSession(5_000, true, true), false);
});

test("timeouts and other network failures reuse the load-failed copy", () => {
  assert.equal(pmLoadErrorMessage(new ApiError("Request timed out", 0, null), loadFailed), loadFailed);
  assert.equal(pmLoadErrorMessage(new ApiError("Network request failed", 0, null), loadFailed), loadFailed);
  assert.equal(pmLoadErrorMessage(new Error("bad"), loadFailed), loadFailed);
});

test("a server error keeps its own message", () => {
  assert.equal(pmLoadErrorMessage(new ApiError("nope", 500, null), loadFailed), "nope");
});
