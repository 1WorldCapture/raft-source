import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePreview } from "@botiverse/raft-shared/src/messageSnippet.ts";
import {
  conversationSummaryStrings,
  formatConversationSummary,
  type ConversationSummaryStrings,
} from "./conversationPreview.ts";

/** Chinese ICU behavior reproduced by hand — same output the device gets from react-intl. */
const ZH: ConversationSummaryStrings = {
  unknownSender: "未知用户",
  senderBody: (sender, body) => `${sender}：${body}`,
  image: "[图片]",
  imageCount: (n) => `[图片]×${n}`,
  attachment: "[附件]",
  attachmentCount: (n) => `[附件]×${n}`,
  taskLabel: (n) => `任务 #${n}`,
};

function preview(overrides: Partial<MessagePreview> = {}): MessagePreview {
  return {
    messageId: "m1",
    kind: "text",
    text: "hello",
    senderType: "user",
    senderId: "u1",
    senderName: "Lyon",
    attachmentCount: 0,
    taskNumber: null,
    ...overrides,
  };
}

test("text preview joins sender and body", () => {
  assert.equal(formatConversationSummary(preview(), ZH), "Lyon：hello");
});

test("null or missing preview renders nothing", () => {
  assert.equal(formatConversationSummary(null, ZH), null);
  assert.equal(formatConversationSummary(undefined, ZH), null);
});

test("missing sender name falls back to the localized unknown sender", () => {
  assert.equal(formatConversationSummary(preview({ senderName: null }), ZH), "未知用户：hello");
  assert.equal(formatConversationSummary(preview({ senderName: "  " }), ZH), "未知用户：hello");
});

test("text with attachments appends the paperclip", () => {
  assert.equal(formatConversationSummary(preview({ attachmentCount: 2 }), ZH), "Lyon：hello 📎");
});

test("image and attachment kinds render placeholders, with counts over one", () => {
  assert.equal(formatConversationSummary(preview({ kind: "image", text: "", attachmentCount: 1 }), ZH), "Lyon：[图片]");
  assert.equal(formatConversationSummary(preview({ kind: "image", text: "", attachmentCount: 3 }), ZH), "Lyon：[图片]×3");
  assert.equal(formatConversationSummary(preview({ kind: "attachment", text: "", attachmentCount: 1 }), ZH), "Lyon：[附件]");
  assert.equal(formatConversationSummary(preview({ kind: "attachment", text: "", attachmentCount: 2 }), ZH), "Lyon：[附件]×2");
});

test("placeholder keeps any remaining body text", () => {
  assert.equal(formatConversationSummary(preview({ kind: "image", text: "看这个", attachmentCount: 1 }), ZH), "Lyon：[图片] 看这个");
});

test("system preview shows its own text without a sender prefix", () => {
  assert.equal(
    formatConversationSummary(preview({ kind: "system", text: "BackendDev 加入了频道", senderName: null }), ZH),
    "BackendDev 加入了频道",
  );
});

test("task preview prefixes the localized task label", () => {
  assert.equal(
    formatConversationSummary(preview({ kind: "task", text: "修复登录 401", taskNumber: 16, senderName: null }), ZH),
    "任务 #16：修复登录 401",
  );
  assert.equal(
    formatConversationSummary(preview({ kind: "task", text: "", taskNumber: 7, senderName: null }), ZH),
    "任务 #7",
  );
});

test("empty body with no attachments renders nothing", () => {
  assert.equal(formatConversationSummary(preview({ text: "", senderName: "Lyon" }), ZH), null);
});

test("conversationSummaryStrings maps every catalog id", () => {
  const seen: Array<string> = [];
  const strings = conversationSummaryStrings<`mobile.conversations.${string}`>((id, values) => {
    seen.push(id);
    if (id === "mobile.conversations.imageCount" || id === "mobile.conversations.attachmentCount" || id === "mobile.conversations.taskLabel") {
      return `${id}:${values?.n}`;
    }
    if (id === "mobile.conversations.senderBody") return `${values?.sender}/${values?.body}`;
    return id;
  });
  assert.equal(strings.unknownSender, "mobile.conversations.unknownSender");
  assert.equal(strings.senderBody("A", "B"), "A/B");
  assert.equal(strings.imageCount(3), "mobile.conversations.imageCount:3");
  assert.equal(strings.attachmentCount(2), "mobile.conversations.attachmentCount:2");
  assert.equal(strings.taskLabel(9), "mobile.conversations.taskLabel:9");
  // Every string the formatter can reach is wired, so no placeholder silently falls back to an id.
  assert.deepEqual(
    new Set(["mobile.conversations.unknownSender", "mobile.conversations.senderBody", "mobile.conversations.image", "mobile.conversations.imageCount", "mobile.conversations.attachment", "mobile.conversations.attachmentCount", "mobile.conversations.taskLabel"]),
    new Set(seen),
  );
});
