import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentAuthHeaders,
  attachmentCacheFilename,
  attachmentDownloadUrl,
  rewriteAttachmentUrl,
} from "./attachmentUrl.ts";

const ORIGIN = "http://10.0.2.2:3001";

test("a streamed attachment URL keeps its path and query on the app server", () => {
  const raw = "http://127.0.0.1:3001/api/attachments/file-1?token=secret&serverId=srv";
  assert.equal(
    rewriteAttachmentUrl(raw, ORIGIN),
    "http://10.0.2.2:3001/api/attachments/file-1?token=secret&serverId=srv",
  );
});

test("an S3 presigned URL is left alone", () => {
  const raw = "https://my-bucket.s3.us-east-1.amazonaws.com/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
  assert.equal(rewriteAttachmentUrl(raw, ORIGIN), raw);
});

test("an R2 presigned URL is left alone", () => {
  const raw = "https://account.r2.cloudflarestorage.com/bucket/file.txt?X-Amz-Signature=abc";
  assert.equal(rewriteAttachmentUrl(raw, ORIGIN), raw);
});

test("relative attachment paths join the app server and keep the query", () => {
  assert.equal(
    rewriteAttachmentUrl("/api/attachments/file-1?token=keep&serverId=srv", ORIGIN),
    "http://10.0.2.2:3001/api/attachments/file-1?token=keep&serverId=srv",
  );
  assert.equal(
    rewriteAttachmentUrl("api/attachments/file-1?disposition=inline", ORIGIN),
    "http://10.0.2.2:3001/api/attachments/file-1?disposition=inline",
  );
});

test("a streamed URL is dropped when the app has no server", () => {
  assert.equal(rewriteAttachmentUrl("http://127.0.0.1:3001/api/attachments/file-1?token=secret", null), null);
  assert.equal(rewriteAttachmentUrl("/api/attachments/file-1", null), null);
});

test("the file download URL carries disposition and not the access token", () => {
  const url = attachmentDownloadUrl(ORIGIN, "file 1");
  assert.equal(url, "http://10.0.2.2:3001/api/attachments/file%201?disposition=attachment");
  assert.equal(url.includes("token="), false);
  const headers = attachmentAuthHeaders("access-token", "srv");
  assert.deepEqual(headers, { Authorization: "Bearer access-token", "X-Server-Id": "srv" });
  assert.equal(JSON.stringify(headers).includes("token="), false);
});

test("cache filenames drop path separators", () => {
  assert.equal(attachmentCacheFilename("reports/q1.txt"), "reports_q1.txt");
  assert.equal(attachmentCacheFilename("   "), "attachment");
});
