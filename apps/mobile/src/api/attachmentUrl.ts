const STREAMED_ATTACHMENT = /^\/api\/attachments(?:\/|$)/;

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function streamedAttachment(url: URL): boolean {
  return STREAMED_ATTACHMENT.test(url.pathname);
}

/**
 * Local storage returns an absolute `/api/attachments/...` URL on whatever host
 * the server was configured with. Keep that path and query, and serve it from
 * the app's own server. Presigned object-storage URLs stay as they are.
 */
export function rewriteAttachmentUrl(raw: string, origin: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const base = origin?.replace(/\/+$/, "") || null;

  let url: URL;
  if (hasScheme(trimmed)) {
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!streamedAttachment(url)) return trimmed;
  } else if (base) {
    try {
      url = new URL(trimmed, `${base}/`);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (streamedAttachment(url)) {
    if (!base) return null;
    return `${base}${url.pathname}${url.search}${url.hash}`;
  }
  if (hasScheme(trimmed) || !base) return hasScheme(trimmed) ? trimmed : null;
  return `${base}${url.pathname}${url.search}${url.hash}`;
}

/** Authenticated file download. The access token stays in the header, not the query. */
export function attachmentDownloadUrl(origin: string, id: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/api/attachments/${encodeURIComponent(id)}?disposition=attachment`;
}

export function attachmentAuthHeaders(token: string, serverId: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (serverId) headers["X-Server-Id"] = serverId;
  return headers;
}

export function attachmentCacheFilename(filename: string): string {
  let cleaned = "";
  for (const char of filename) {
    const code = char.charCodeAt(0);
    if (char === "/" || char === "\\") cleaned += "_";
    else if (code >= 32) cleaned += char;
  }
  const base = cleaned.trim().slice(0, 120);
  return base.length > 0 ? base : "attachment";
}
