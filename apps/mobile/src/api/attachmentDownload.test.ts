import assert from "node:assert/strict";
import test from "node:test";
import {
  AttachmentHttpError,
  attachmentAccessTokenNeedsRefresh,
  downloadAttachmentWithFreshToken,
  httpStatusFromDownloadError,
} from "./attachmentDownload.ts";

function tokenExpiringAt(expMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url");
  return `aaa.${payload}.sig`;
}

const NOW = 1_700_000_000_000;
const URL = "http://10.0.2.2:3001/api/attachments/file-1?disposition=attachment";

test("a token inside the refresh window is refreshed before download", async () => {
  const calls: string[] = [];
  let token = tokenExpiringAt(NOW + 30_000);
  await downloadAttachmentWithFreshToken({
    url: URL,
    now: () => NOW,
    getAccessToken: () => token,
    getHeaders: () => ({ Authorization: `Bearer ${token}` }),
    refreshTokens: async () => {
      calls.push("refresh");
      token = tokenExpiringAt(NOW + 15 * 60_000);
    },
    download: async (attempt) => {
      calls.push(attempt.headers.Authorization);
      assert.equal(attempt.url.includes("token="), false);
    },
  });
  assert.deepEqual(calls, ["refresh", `Bearer ${token}`]);
});

test("a token with time left is sent once and not refreshed first", async () => {
  let refreshed = 0;
  const token = tokenExpiringAt(NOW + 10 * 60_000);
  assert.equal(attachmentAccessTokenNeedsRefresh(token, NOW), false);
  await downloadAttachmentWithFreshToken({
    url: URL,
    now: () => NOW,
    getAccessToken: () => token,
    getHeaders: () => ({ Authorization: "Bearer fresh" }),
    refreshTokens: async () => {
      refreshed += 1;
    },
    download: async () => undefined,
  });
  assert.equal(refreshed, 0);
});

test("a 401 refreshes once and retries with the new token", async () => {
  const seen: string[] = [];
  let token = tokenExpiringAt(NOW + 10 * 60_000);
  const expired = token;
  await downloadAttachmentWithFreshToken({
    url: URL,
    now: () => NOW,
    getAccessToken: () => token,
    getHeaders: () => ({ Authorization: `Bearer ${token}` }),
    refreshTokens: async () => {
      token = tokenExpiringAt(NOW + 20 * 60_000);
    },
    download: async (attempt) => {
      seen.push(attempt.headers.Authorization);
      if (attempt.headers.Authorization === `Bearer ${expired}`) {
        throw new Error("response has status: 401");
      }
    },
  });
  assert.deepEqual(seen, [`Bearer ${expired}`, `Bearer ${token}`]);
});

test("a second 401 fails and is not downloaded again", async () => {
  let downloads = 0;
  let refreshes = 0;
  await assert.rejects(
    () => downloadAttachmentWithFreshToken({
      url: URL,
      now: () => NOW,
      getAccessToken: () => tokenExpiringAt(NOW + 10 * 60_000),
      getHeaders: () => ({ Authorization: "Bearer still-expired" }),
      refreshTokens: async () => {
        refreshes += 1;
      },
      download: async () => {
        downloads += 1;
        throw new Error("response has status: 401");
      },
    }),
    (error: unknown) => error instanceof AttachmentHttpError && error.status === 401,
  );
  assert.equal(downloads, 2);
  assert.equal(refreshes, 1);
});

test("a non-2xx response is a failure and is not retried", async () => {
  let downloads = 0;
  await assert.rejects(
    () => downloadAttachmentWithFreshToken({
      url: URL,
      now: () => NOW,
      getAccessToken: () => tokenExpiringAt(NOW + 10 * 60_000),
      getHeaders: () => ({ Authorization: "Bearer ok" }),
      refreshTokens: async () => {
        throw new Error("refresh should not run");
      },
      download: async () => {
        downloads += 1;
        throw new Error("response has status: 500");
      },
    }),
    (error: unknown) => error instanceof AttachmentHttpError && error.status === 500,
  );
  assert.equal(downloads, 1);
  assert.equal(httpStatusFromDownloadError(new Error("server returned HTTP 403")), 403);
});
