import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMessagePreview,
  buildMessageSnippet,
  MESSAGE_PREVIEW_MAX_CHARS,
  toMessagePlainText,
} from "./messageSnippet.js";

const base = { messageId: "m-1", messageType: "chat", senderType: "agent", senderId: "a-1", senderName: "Firstmate" };

test("toMessagePlainText strips Markdown and decodes common entities", () => {
  assert.equal(toMessagePlainText("snake_case and _emphasis_"), "snake_case and emphasis");
  assert.equal(toMessagePlainText("a &amp; b &lt;c&gt;"), "a & b <c>");
  assert.equal(toMessagePlainText(""), "");
});

test("buildMessageSnippet keeps mentions and link labels, drops fences, collapses whitespace", () => {
  assert.equal(
    buildMessageSnippet("## Status\n\n- **done**: `api`\n\n```ts\nconst a = 1;\n```\n\n<@Anna> see [the PR](https://example.test/pr/1)", 120),
    "Status done: api const a = 1; @Anna see the PR",
  );
});

test("buildMessageSnippet truncates by code point without splitting emoji", () => {
  const snippet = buildMessageSnippet("😀".repeat(130), 120);
  const chars = Array.from(snippet);
  assert.equal(chars.length, 120);
  assert.equal(chars.at(-1), "…");
  assert.ok(chars.slice(0, -1).every((char) => char === "😀"));
  assert.equal(buildMessageSnippet("short", 120), "short");
});

test("text preview: Markdown and refs become plain text capped at the preview length", () => {
  const preview = buildMessagePreview({ ...base, content: "**Done** with `step 1` <@Anna> see [the PR](https://x.test)" });
  assert.deepEqual(preview, {
    messageId: "m-1",
    kind: "text",
    text: "Done with step 1 @Anna see the PR",
    senderType: "agent",
    senderId: "a-1",
    senderName: "Firstmate",
    attachmentCount: 0,
    taskNumber: null,
  });
  const long = buildMessagePreview({ ...base, content: "字".repeat(200) });
  assert.equal(Array.from(long.text).length, MESSAGE_PREVIEW_MAX_CHARS);
});

test("text with attachments stays text and reports the count", () => {
  const preview = buildMessagePreview({ ...base, content: "see files", attachments: [{ mimeType: "image/png" }, { mimeType: "application/pdf" }] });
  assert.equal(preview.kind, "text");
  assert.equal(preview.attachmentCount, 2);
});

test("image and attachment kinds, from a realtime list or from counts", () => {
  assert.equal(buildMessagePreview({ ...base, content: "", attachments: [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }] }).kind, "image");
  assert.equal(buildMessagePreview({ ...base, content: null, attachments: [{ mimeType: "image/png" }, { mimeType: "text/plain" }] }).kind, "attachment");
  assert.equal(buildMessagePreview({ ...base, content: "", attachments: [{ mimeType: null }] }).kind, "attachment");
  const fromCounts = buildMessagePreview({ ...base, content: "", attachmentCount: 3, imageAttachmentCount: 3 });
  assert.equal(fromCounts.kind, "image");
  assert.equal(fromCounts.text, "");
  assert.equal(fromCounts.attachmentCount, 3);
  assert.equal(buildMessagePreview({ ...base, content: "", attachmentCount: 1, imageAttachmentCount: 0 }).kind, "attachment");
});

test("system and task kinds take precedence", () => {
  const system = buildMessagePreview({ ...base, messageType: "system", content: "BackendDev joined the channel", taskNumber: 4 });
  assert.equal(system.kind, "system");
  assert.equal(system.text, "BackendDev joined the channel");
  assert.equal(system.taskNumber, null);
  const task = buildMessagePreview({ ...base, content: "修复登录 401", taskNumber: 16 });
  assert.equal(task.kind, "task");
  assert.equal(task.text, "修复登录 401");
  assert.equal(task.taskNumber, 16);
});

test("empty content with no attachments is an empty text preview; unknown sender fields normalize", () => {
  const preview = buildMessagePreview({ messageId: "m-2", messageType: "chat", content: "   ", senderType: "robot", senderName: "  " });
  assert.equal(preview.kind, "text");
  assert.equal(preview.text, "");
  assert.equal(preview.senderType, "user");
  assert.equal(preview.senderId, null);
  assert.equal(preview.senderName, null);
});
