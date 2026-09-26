import { isRecord } from "../model/messages";

export function uploadProgressPercent(loaded: number, total: number | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.max(1, Math.min(99, Math.round((loaded / total) * 100)));
}

export function parseUploadedAttachmentId(data: unknown): string | null {
  if (!isRecord(data) || !Array.isArray(data.attachments)) return null;
  const first = data.attachments[0];
  return isRecord(first) && typeof first.id === "string" ? first.id : null;
}

/** A retry uses only the ids stored on that message, even when the composer has other files. */
export function attachmentIdsForSend(input: {
  retry: boolean;
  pendingIds: readonly string[];
  messageIds: readonly (string | undefined)[];
}): string[] {
  if (input.retry) return input.messageIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...input.pendingIds];
}

/** `#` at the end of the draft. `@` and `#` cannot both match. */
export function channelQuery(draft: string): string | null {
  const match = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u.exec(draft);
  return match ? match[1] ?? "" : null;
}
