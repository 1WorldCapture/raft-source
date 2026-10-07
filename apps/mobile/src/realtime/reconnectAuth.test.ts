import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessTokenExp, planReconnectAuthRefresh } from "./reconnectAuth.ts";

const freshAuth = { token: "latest", serverId: "s", clientKind: "mobile" };

test("planReconnectAuthRefresh skips when there is no token", () => {
  assert.deepEqual(
    planReconnectAuthRefresh({
      latestAccessToken: null,
      freshAuth,
      parseTokenExp: () => 1_000,
      now: 0,
    }),
    { type: "skip", reason: "no-token" },
  );
});

test("planReconnectAuthRefresh refreshes expired, near-expiry, and unreadable tokens", () => {
  assert.equal(
    planReconnectAuthRefresh({
      latestAccessToken: "t",
      freshAuth,
      parseTokenExp: () => 1_000,
      now: 1_000,
    }).type,
    "trigger-refresh-and-update",
  );
  assert.equal(
    planReconnectAuthRefresh({
      latestAccessToken: "t",
      freshAuth,
      parseTokenExp: () => 30_000,
      now: 0,
    }).type,
    "trigger-refresh-and-update",
  );
  assert.equal(
    planReconnectAuthRefresh({
      latestAccessToken: "t",
      freshAuth,
      parseTokenExp: () => null,
      now: 0,
    }).type,
    "trigger-refresh-and-update",
  );
});

test("planReconnectAuthRefresh updates auth in place when the token is fresh", () => {
  assert.deepEqual(
    planReconnectAuthRefresh({
      latestAccessToken: "t",
      freshAuth,
      parseTokenExp: () => 120_000,
      now: 0,
    }),
    { type: "update-auth-only", auth: freshAuth },
  );
});

test("parseAccessTokenExp reads the exp claim in milliseconds", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
  const token = `aaa.${payload}.zzz`;
  assert.equal(parseAccessTokenExp(token), 1_700_000_000_000);
  assert.equal(parseAccessTokenExp("not-a-jwt"), null);
});
