import api from "../../api/client";

/**
 * Rasterize an SVG attachment to a PNG object URL, fully in memory.
 *
 * Why not hand `<img>` the SVG bytes directly (as a blob URL)? A `blob:` URL
 * inherits the ORIGIN of this web app: navigating to it ("open image in new
 * tab") makes the browser render the SVG as a live document on our origin,
 * where its scripts would execute and could read localStorage (stored XSS).
 * This is exactly what the server's `disposition=attachment` download
 * posture defends against.
 *
 * So the raw SVG blob exists only inside this module: it is decoded through
 * an offscreen `Image` (image context — scripts are inert), drawn to a
 * canvas, exported as PNG, and the SVG object URL is revoked before the PNG
 * URL is ever returned. Callers only ever hold a PNG object URL, so "open
 * image in new tab" yields a static, script-free bitmap.
 */

/** Long-edge cap for the rasterized preview. */
const PNG_LONG_EDGE_MAX = 2048;

/** Fallback canvas size for SVGs with no intrinsic or viewBox size. */
const PNG_DEFAULT_EDGE = 1024;

const pngUrlCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

function drawSize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  let width = naturalWidth > 0 ? naturalWidth : PNG_DEFAULT_EDGE;
  let height = naturalHeight > 0 ? naturalHeight : PNG_DEFAULT_EDGE;
  const longEdge = Math.max(width, height);
  if (longEdge > PNG_LONG_EDGE_MAX) {
    const scale = PNG_LONG_EDGE_MAX / longEdge;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height };
}

function decodeSvgImage(svgUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("SVG preview decode failed"));
    image.src = svgUrl;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

/**
 * NOTE ON ABORT: callers deliberately cannot cancel the shared request —
 * same contract as inlineAttachmentUrlCache (virtualised tiles unmount
 * constantly; the shared promise must outlive any single subscriber).
 */
export async function fetchSvgPngPreviewUrl(attachmentId: string): Promise<string | null> {
  const hit = pngUrlCache.get(attachmentId);
  if (hit) return hit;

  const pending = inFlight.get(attachmentId);
  if (pending) return pending;

  const request = (async (): Promise<string | null> => {
    // Raw bytes travel only through the app's own API origin (axios), never
    // as a presigned cross-origin URL (whose response carries
    // `Cross-Origin-Resource-Policy: same-origin` anyway).
    const { data: svgBlob } = await api.get<Blob>(
      `/attachments/${attachmentId}?disposition=inline`,
      { responseType: "blob" },
    );
    const svgUrl = URL.createObjectURL(svgBlob);
    try {
      // Offscreen Image decode: an image context cannot execute SVG scripts
      // or fetch external references, regardless of file contents.
      const image = await decodeSvgImage(svgUrl);
      const { width, height } = drawSize(image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0, width, height);
      const pngBlob = await canvasToPngBlob(canvas);
      if (!pngBlob) return null;
      // Only the PNG object URL is ever exposed to callers.
      const pngUrl = URL.createObjectURL(pngBlob);
      pngUrlCache.set(attachmentId, pngUrl);
      return pngUrl;
    } finally {
      // The raw SVG blob URL is revoked before callers see anything.
      URL.revokeObjectURL(svgUrl);
    }
  })()
    .catch(() => null)
    .finally(() => {
      inFlight.delete(attachmentId);
    });
  inFlight.set(attachmentId, request);
  return request;
}

/** Drop a cached PNG preview that failed to load, so the next render refetches. */
export function invalidateSvgPngPreview(attachmentId: string): void {
  const url = pngUrlCache.get(attachmentId);
  if (url) URL.revokeObjectURL(url);
  pngUrlCache.delete(attachmentId);
}

export function getCachedSvgPngPreviewUrl(attachmentId: string): string | null {
  return pngUrlCache.get(attachmentId) ?? null;
}
