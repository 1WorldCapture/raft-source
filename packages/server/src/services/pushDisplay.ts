import { toMessagePlainText } from "@botiverse/raft-shared/src/messageSnippet.js";

const MAX_PUSH_BODY_LENGTH = 140;

/**
 * Produce notification-safe display text from message Markdown. The single
 * implementation lives in shared `messageSnippet` so push, task-board and
 * conversation-list text (server and mobile) cannot drift apart.
 */
export const toNotificationPlainText = toMessagePlainText;

export function summarizePushBody(content: string, attachmentCount: number): string {
  const normalized = toNotificationPlainText(content).replace(/\s+/g, " ").trim();
  if (normalized) {
    return normalized.length <= MAX_PUSH_BODY_LENGTH
      ? normalized
      : `${normalized.slice(0, MAX_PUSH_BODY_LENGTH - 1)}…`;
  }
  if (attachmentCount === 1) return "Sent an attachment";
  if (attachmentCount > 1) return `Sent ${attachmentCount} attachments`;
  return "(no text)";
}

export function formatPushServerLabel(serverName: string | null | undefined, serverSlug: string): string {
  const trimmed = serverName?.trim();
  return trimmed || serverSlug;
}

export function formatPushSurfaceTitle(surface: string, serverLabel: string): string {
  return `${surface} · ${serverLabel}`;
}

export function formatPushBody(senderName: string, body: string, mentioned = false): string {
  return mentioned
    ? `${senderName} mentioned you: ${body}`
    : `${senderName}: ${body}`;
}
