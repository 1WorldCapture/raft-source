import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import {
  AttachmentHttpError,
  downloadAttachmentWithFreshToken,
  type AttachmentDownloadAttempt,
} from "../api/attachmentDownload";
import { attachmentCacheFilename } from "../api/attachmentUrl";

export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 120_000;

function removePartial(destination: File): void {
  if (!destination.exists) return;
  destination.delete();
}

async function downloadToFile(attempt: AttachmentDownloadAttempt, destination: File): Promise<void> {
  try {
    await File.downloadFileAsync(attempt.url, destination, {
      headers: attempt.headers,
      idempotent: true,
      signal: attempt.signal,
    });
  } catch (error) {
    removePartial(destination);
    throw error;
  }
}

/** Download with a fresh access token, then hand the file to the system share sheet. */
export async function downloadAndShareAttachment(input: {
  url: string;
  getAccessToken: () => string | null;
  getHeaders: () => Record<string, string>;
  refreshTokens: () => Promise<void>;
  filename: string;
  mimeType?: string;
  timeoutMs?: number;
}): Promise<void> {
  const directory = new Directory(Paths.cache, "attachments");
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, attachmentCacheFilename(input.filename));
  await downloadAttachmentWithFreshToken({
    url: input.url,
    getAccessToken: input.getAccessToken,
    getHeaders: input.getHeaders,
    refreshTokens: input.refreshTokens,
    timeoutMs: input.timeoutMs ?? ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    download: (attempt) => downloadToFile(attempt, destination),
  });
  if (!destination.exists) throw new AttachmentHttpError(500);
  if (!(await isAvailableAsync())) throw new Error("sharing unavailable");
  await shareAsync(destination.uri, {
    mimeType: input.mimeType,
    dialogTitle: input.filename,
  });
}
