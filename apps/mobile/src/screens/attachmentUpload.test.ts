import assert from "node:assert/strict";
import test from "node:test";
import { attachmentIdsForSend, channelQuery, parseUploadedAttachmentId, uploadProgressPercent } from "./attachmentUpload";

test("upload progress stays between 1 and 99 until the request finishes", () => {
  assert.equal(uploadProgressPercent(0, 0), null);
  assert.equal(uploadProgressPercent(1, 4), 25);
  assert.equal(uploadProgressPercent(4, 4), 99);
});

test("upload responses yield the first attachment id", () => {
  assert.equal(parseUploadedAttachmentId({ attachments: [{ id: "file-1" }] }), "file-1");
  assert.equal(parseUploadedAttachmentId({ attachments: [] }), null);
});

test("a failed send retries the attachment ids stored on the message", () => {
  assert.deepEqual(attachmentIdsForSend(["composer-1"], ["file-1", "file-2"]), ["file-1", "file-2"]);
  assert.deepEqual(attachmentIdsForSend(["composer-1"], []), ["composer-1"]);
  assert.deepEqual(attachmentIdsForSend(["composer-1"]), ["composer-1"]);
});

test("channel query reads the hash at the end of the draft", () => {
  assert.equal(channelQuery("see #ra"), "ra");
  assert.equal(channelQuery("see #ra "), null);
  assert.equal(channelQuery("hello @ada"), null);
});
