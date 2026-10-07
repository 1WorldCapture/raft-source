import { parseAccessTokenExp } from "../realtime/reconnectAuth";

/** Refresh when the access token expires inside this window. Matches socket reconnect. */
export const ATTACHMENT_REFRESH_SOON_MS = 60_000;

export class AttachmentHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`attachment response has status: ${status}`);
    this.name = "AttachmentHttpError";
    this.status = status;
  }
}

/** True when the token is missing an expiry or expires inside the refresh window. */
export function attachmentAccessTokenNeedsRefresh(
  token: string | null,
  now: number,
  thresholdMs = ATTACHMENT_REFRESH_SOON_MS,
): boolean {
  if (!token) return false;
  const exp = parseAccessTokenExp(token);
  if (exp === null) return true;
  return exp - now < thresholdMs;
}

/** Status from our own error or from expo-file-system's UnableToDownload message. */
export function httpStatusFromDownloadError(error: unknown): number | null {
  if (error instanceof AttachmentHttpError) return error.status;
  const message = error instanceof Error ? error.message : "";
  const match = /status:?\s*(\d{3})\b|HTTP\s+(\d{3})\b/.exec(message);
  if (!match) return null;
  return Number(match[1] ?? match[2]);
}

export interface AttachmentDownloadAttempt {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}

/**
 * Refresh a near-expiry access token before downloading. On 401, refresh once
 * and retry once. The download function must reject for every non-2xx response
 * so a failure body is never treated as a saved file.
 */
export async function downloadAttachmentWithFreshToken(input: {
  url: string;
  getAccessToken: () => string | null;
  getHeaders: () => Record<string, string>;
  refreshTokens: () => Promise<void>;
  download: (attempt: AttachmentDownloadAttempt) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  thresholdMs?: number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  if (attachmentAccessTokenNeedsRefresh(input.getAccessToken(), now(), input.thresholdMs)) {
    await input.refreshTokens();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 120_000);
  try {
    await attempt(false);
  } finally {
    clearTimeout(timer);
  }

  async function attempt(retried: boolean): Promise<void> {
    const headers = input.getHeaders();
    if (!headers.Authorization) throw new AttachmentHttpError(401);
    try {
      await input.download({ url: input.url, headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const status = httpStatusFromDownloadError(error);
      if (status === null) throw error;
      if (status === 401 && !retried) {
        await input.refreshTokens();
        return attempt(true);
      }
      throw new AttachmentHttpError(status);
    }
  }
}
