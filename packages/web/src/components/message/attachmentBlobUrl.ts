import api from "../../api/client";

/**
 * Session cache + in-flight dedupe for same-origin attachment blob URLs.
 *
 * Presigned attachment URLs point at the API origin (SERVER_URL), which is a
 * DIFFERENT origin from the web app (5173 vs 3001). Attachment responses carry
 * `Cross-Origin-Resource-Policy: same-origin`, so a cross-origin `<img src>`
 * embedding of that URL is blocked with ERR_BLOCKED_BY_RESPONSE. Routing the
 * bytes through the app's own API origin (axios) and handing `<img>` a local
 * object URL keeps every image source first-party regardless of where the API
 * host lives.
 *
 * Used for SVG gallery/preview sources, where no CDN raster/thumbnail exists
 * and the raw file must render inside an `<img>` sandbox.
 */
const blobUrlCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

/** Drop a cached object URL that failed to load, so the next render refetches. */
export function invalidateAttachmentBlobUrl(attachmentId: string): void {
  const url = blobUrlCache.get(attachmentId);
  if (url) URL.revokeObjectURL(url);
  blobUrlCache.delete(attachmentId);
}

export function getCachedAttachmentBlobUrl(attachmentId: string): string | null {
  return blobUrlCache.get(attachmentId) ?? null;
}

/**
 * NOTE ON ABORT: callers deliberately cannot cancel the shared request —
 * same contract as inlineAttachmentUrlCache (virtualised tiles unmount
 * constantly; the shared promise must outlive any single subscriber).
 */
export async function fetchAttachmentBlobUrl(attachmentId: string): Promise<string | null> {
  const hit = blobUrlCache.get(attachmentId);
  if (hit) return hit;

  const pending = inFlight.get(attachmentId);
  if (pending) return pending;

  const request = api
    .get<Blob>(`/attachments/${attachmentId}?disposition=inline`, { responseType: "blob" })
    .then(({ data }) => {
      const url = URL.createObjectURL(data);
      blobUrlCache.set(attachmentId, url);
      return url;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(attachmentId);
    });
  inFlight.set(attachmentId, request);
  return request;
}
