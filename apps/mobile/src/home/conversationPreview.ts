// Conversation-list summary line (task #5).
//
// The structured preview comes from the server (`lastMessagePreview`) or is
// built locally from a `message:new` payload with the same shared
// `buildMessagePreview`; this module only turns it into one locale-aware line
// of text. Placeholder copy such as "[Image]" is rendered here, not on the
// server, and strings are injected so unit tests run without i18n or React.
import type { MessagePreview } from "@botiverse/raft-shared/src/messageSnippet.ts";

export interface ConversationSummaryStrings {
  /** Shown when the preview has no resolvable sender name. */
  unknownSender: string;
  /** Joins a sender name and a body, e.g. `Lyon：你好` / `Lyon: hi`. */
  senderBody: (sender: string, body: string) => string;
  image: string;
  imageCount: (n: number) => string;
  attachment: string;
  attachmentCount: (n: number) => string;
  taskLabel: (n: number) => string;
}

const PAPERCLIP = "📎";

/**
 * Render the latest-message preview as a single line, or null when there is
 * nothing to show (no preview, or an empty body). System messages carry their
 * own text and skip the sender prefix; image/attachment/task kinds get a
 * localized placeholder before any remaining body text.
 */
export function formatConversationSummary(
  preview: MessagePreview | null | undefined,
  strings: ConversationSummaryStrings,
): string | null {
  if (!preview) return null;
  if (preview.kind === "system") return preview.text || null;
  if (preview.kind === "task") {
    const label = strings.taskLabel(preview.taskNumber ?? 0);
    return preview.text ? strings.senderBody(label, preview.text) : label;
  }

  let body = preview.text;
  if (preview.kind === "image" || preview.kind === "attachment") {
    const count = Math.max(1, preview.attachmentCount);
    const placeholder = preview.kind === "image"
      ? (count > 1 ? strings.imageCount(count) : strings.image)
      : (count > 1 ? strings.attachmentCount(count) : strings.attachment);
    body = body ? `${placeholder} ${body}` : placeholder;
  } else if (preview.attachmentCount > 0) {
    body = body ? `${body} ${PAPERCLIP}` : PAPERCLIP;
  }
  if (!body) return null;

  const sender = preview.senderName?.trim() || strings.unknownSender;
  return strings.senderBody(sender, body);
}

/** Build the strings from any intl-style `format(id, values)` (react-intl's t). */
export function conversationSummaryStrings<T extends string>(
  format: (id: T, values?: Record<string, string | number>) => string,
): ConversationSummaryStrings {
  return {
    unknownSender: format("mobile.conversations.unknownSender" as T),
    senderBody: (sender, body) => format("mobile.conversations.senderBody" as T, { sender, body }),
    image: format("mobile.conversations.image" as T),
    imageCount: (n) => format("mobile.conversations.imageCount" as T, { n }),
    attachment: format("mobile.conversations.attachment" as T),
    attachmentCount: (n) => format("mobile.conversations.attachmentCount" as T, { n }),
    taskLabel: (n) => format("mobile.conversations.taskLabel" as T, { n }),
  };
}
