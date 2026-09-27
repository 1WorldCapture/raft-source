import { Directory, File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import { attachmentCacheFilename } from "../api/attachmentUrl";

export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Download with auth headers, then hand the file to the system share sheet. */
export async function downloadAndShareAttachment(input: {
  url: string;
  headers: Record<string, string>;
  filename: string;
  mimeType?: string;
  timeoutMs?: number;
}): Promise<void> {
  const directory = new Directory(Paths.cache, "attachments");
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  const destination = new File(directory, attachmentCacheFilename(input.filename));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
  try {
    const downloaded = await File.downloadFileAsync(input.url, destination, {
      headers: input.headers,
      idempotent: true,
      signal: controller.signal,
    });
    if (!(await isAvailableAsync())) throw new Error("sharing unavailable");
    await shareAsync(downloaded.uri, {
      mimeType: input.mimeType,
      dialogTitle: input.filename,
    });
  } finally {
    clearTimeout(timer);
  }
}
