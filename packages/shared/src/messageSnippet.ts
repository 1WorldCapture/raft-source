// Message summary text shared by the server (push notifications, task board,
// conversation-list previews) and the mobile app (realtime previews).
//
// Portability contract: the mobile app imports this file by path
// (`@botiverse/raft-shared/src/messageSnippet.ts`), so it must not import the
// shared package root and must not use `.js`-suffixed relative imports. Its
// only dependencies are `marked` and `marked-plaintify`.
import { Marked } from "marked";
import markedPlaintify from "marked-plaintify";

const MAX_MARKDOWN_SOURCE_LENGTH = 4_096;
export const MESSAGE_PREVIEW_MAX_CHARS = 80;

const MARKDOWN_TO_PLAIN_TEXT = new Marked({ gfm: true }).use(markedPlaintify({
  code: ({ text }) => `${text}\n\n`,
  codespan: ({ text }) => text,
  html: () => "",
  image: ({ text }) => `${text || "Image"} `,
  link({ tokens }) {
    return this.parser.parseInline(tokens);
  },
}));

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  "#39": "'",
  nbsp: " ",
};

function decodeCommonHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (entity, name: string) => (
    HTML_ENTITY_REPLACEMENTS[name.toLowerCase()] ?? entity
  ));
}

/**
 * Produce display-safe plain text from message Markdown.
 *
 * This is a derived preview only: the persisted message body is never
 * rewritten. Keep the transform transport-agnostic so push notifications,
 * socket notifications, task boards and conversation lists cannot drift into
 * separate display rules.
 */
export function toMessagePlainText(content: string): string {
  const boundedSource = content.slice(0, MAX_MARKDOWN_SOURCE_LENGTH);
  const rendered = MARKDOWN_TO_PLAIN_TEXT.parse(boundedSource);
  if (typeof rendered !== "string") {
    throw new Error("Message Markdown renderer unexpectedly returned an async result");
  }
  return decodeCommonHtmlEntities(rendered).trim();
}

/**
 * Plain-text, single-line snippet: Markdown and code fences are stripped,
 * angle mention refs become `@name`, whitespace collapses, and truncation
 * counts code points so a surrogate pair (emoji) is never cut in half.
 */
export function buildMessageSnippet(content: string, maxChars: number): string {
  const withMentions = content.replace(/\\?<@([\p{L}\p{N}_-]+)>/gu, "@$1");
  const plain = toMessagePlainText(withMentions).replace(/\s+/g, " ").trim();
  const chars = Array.from(plain);
  if (chars.length <= maxChars) return plain;
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export type MessagePreviewKind = "text" | "image" | "attachment" | "task" | "system";
export type MessagePreviewSenderType = "user" | "agent" | "system" | "external_projection";

/**
 * Structured latest-message summary. Placeholder copy such as "[Image]" is
 * deliberately absent: clients render it from `kind` in their own locale.
 */
export interface MessagePreview {
  messageId: string;
  kind: MessagePreviewKind;
  /** Plain single-line text, at most MESSAGE_PREVIEW_MAX_CHARS code points; "" when there is none. */
  text: string;
  senderType: MessagePreviewSenderType;
  senderId: string | null;
  /** Display name; null when unknown (clients show their own fallback). */
  senderName: string | null;
  attachmentCount: number;
  /** Set only for kind "task". */
  taskNumber: number | null;
}

export interface MessagePreviewInput {
  messageId: string;
  messageType: string;
  content: string | null | undefined;
  senderType: string;
  senderId?: string | null;
  senderName?: string | null;
  taskNumber?: number | null;
  /** Realtime payloads pass the attachment list... */
  attachments?: ReadonlyArray<{ mimeType?: string | null }> | null;
  /** ...list queries pass counts instead. Ignored when `attachments` is given. */
  attachmentCount?: number | null;
  imageAttachmentCount?: number | null;
}

const PREVIEW_SENDER_TYPES: ReadonlySet<string> = new Set(["user", "agent", "system", "external_projection"]);

/**
 * Kind precedence: system message → task host message → text (attachments
 * may accompany it) → image (only images, no text) → attachment.
 */
export function buildMessagePreview(input: MessagePreviewInput): MessagePreview {
  const attachmentCount = input.attachments
    ? input.attachments.length
    : Math.max(0, input.attachmentCount ?? 0);
  const imageAttachmentCount = input.attachments
    ? input.attachments.filter((attachment) => attachment.mimeType?.startsWith("image/")).length
    : Math.max(0, input.imageAttachmentCount ?? 0);
  const text = input.content ? buildMessageSnippet(input.content, MESSAGE_PREVIEW_MAX_CHARS) : "";
  const taskNumber = typeof input.taskNumber === "number" ? input.taskNumber : null;

  let kind: MessagePreviewKind;
  if (input.messageType === "system") kind = "system";
  else if (taskNumber != null) kind = "task";
  else if (text) kind = "text";
  else if (attachmentCount > 0 && imageAttachmentCount === attachmentCount) kind = "image";
  else if (attachmentCount > 0) kind = "attachment";
  else kind = "text";

  return {
    messageId: input.messageId,
    kind,
    text,
    senderType: (PREVIEW_SENDER_TYPES.has(input.senderType) ? input.senderType : "user") as MessagePreviewSenderType,
    senderId: input.senderId ?? null,
    senderName: input.senderName?.trim() || null,
    attachmentCount,
    taskNumber: kind === "task" ? taskNumber : null,
  };
}
