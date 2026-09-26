import assert from "node:assert/strict";
import test from "node:test";
import { channelQuery, parseUploadedAttachmentId, uploadProgressPercent } from "./attachmentUpload";

test("upload progress stays between 1 and 99 until the request finishes", () => {
  assert.equal(uploadProgressPercent(0, 0), null);
  assert.equal(uploadProgressPercent(1, 4), 25);
  assert.equal(uploadProgressPercent(4, 4), 99);
});

test("upload responses yield the first attachment id", () => {
  assert.equal(parseUploadedAttachmentId({ attachments: [{ id: "file-1" }] }), "file-1");
  assert.equal(parseUploadedAttachmentId({ attachments: [] }), null);
});

test("channel query reads the hash at the end of the draft", () => {
  assert.equal(channelQuery("see #ra"), "ra");
  assert.equal(channelQuery("see #ra "), null);
  assert.equal(channelQuery("hello @ada"), null);
});
