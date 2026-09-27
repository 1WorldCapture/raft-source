import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
const { default: api } = await import("../src/api/client");
const {
  fetchAttachmentBlobUrl,
  getCachedAttachmentBlobUrl,
  invalidateAttachmentBlobUrl,
} = await import("../src/components/message/attachmentBlobUrl");

const originalApiGet = api.get;
const createdUrls: string[] = [];

// jsdom lacks URL.createObjectURL; stub it for the cache contract test.
(URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () => {
  const url = `blob:mock-${createdUrls.length}`;
  createdUrls.push(url);
  return url;
};
(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};

function fakeBlobResponse(bytes: number): { data: Blob } {
  return { data: new Blob([new Uint8Array(bytes)], { type: "image/svg+xml" }) };
}

afterEach(() => {
  api.get = originalApiGet;
});

test("fetchAttachmentBlobUrl resolves a same-origin blob URL through the direct endpoint", async () => {
  const requested: string[] = [];
  api.get = (async (url: string) => {
    requested.push(url);
    return fakeBlobResponse(64);
  }) as typeof api.get;

  const url = await fetchAttachmentBlobUrl("blob-test-attachment");
  assert.match(url ?? "", /^blob:mock-/);
  assert.deepEqual(requested, ["/attachments/blob-test-attachment?disposition=inline"], "must hit the same-origin bytes endpoint, not the presigned /url route");
  assert.equal(getCachedAttachmentBlobUrl("blob-test-attachment"), url, "the object URL must be session-cached");
});

test("concurrent and repeat requests reuse one cached object URL", async () => {
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return fakeBlobResponse(16);
  }) as typeof api.get;

  const [a, b] = await Promise.all([fetchAttachmentBlobUrl("blob-dedupe-attachment"), fetchAttachmentBlobUrl("blob-dedupe-attachment")]);
  assert.equal(a, b);
  assert.equal(calls, 1, "in-flight requests must be shared");

  const again = await fetchAttachmentBlobUrl("blob-dedupe-attachment");
  assert.equal(again, a, "repeat opens must reuse the cached object URL");
  assert.equal(calls, 1);
});

test("a failed fetch resolves null without caching, and invalidation drops entries", async () => {
  api.get = (async () => {
    throw new Error("network down");
  }) as typeof api.get;
  const failed = await fetchAttachmentBlobUrl("blob-fail-attachment");
  assert.equal(failed, null);
  assert.equal(getCachedAttachmentBlobUrl("blob-fail-attachment"), null, "failures must not poison the cache");

  api.get = (async () => fakeBlobResponse(8)) as typeof api.get;
  const ok = await fetchAttachmentBlobUrl("blob-invalidate-attachment");
  assert.match(ok ?? "", /^blob:mock-/);
  invalidateAttachmentBlobUrl("blob-invalidate-attachment");
  assert.equal(getCachedAttachmentBlobUrl("blob-invalidate-attachment"), null);
});
