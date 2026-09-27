import type { MessageAttachment } from "../../store/messageStore";

type ImageGalleryPreviewSource = Pick<MessageAttachment, "id" | "localPreviewUrl" | "thumbnailUrl" | "rasterPreviewUrl">;

/** Native `<img>` SVG rendering cap: browsers render SVG in a sandboxed image
 *  context (no script execution, no external loads), but huge or malformed
 *  files can still stall decode, so oversize SVGs stay attachment chips. */
export const SVG_NATIVE_RENDER_MAX_BYTES = 2 * 1024 * 1024;

export function isPreviewableImageAttachment(att: MessageAttachment): boolean {
  const mimeType = att.mimeType.split(";")[0].trim().toLowerCase();
  if (mimeType === "image/svg+xml") {
    // `<img>` falls back to the authenticated original file when no CDN
    // thumbnail/raster exists; oversize SVGs stay chips.
    if (att.sizeBytes != null && att.sizeBytes > SVG_NATIVE_RENDER_MAX_BYTES) return false;
    return true;
  }
  return mimeType.startsWith("image/");
}

export function isOptimisticAttachment(att: Pick<MessageAttachment, "id">): boolean {
  return att.id.startsWith("optimistic-att-");
}

export function shouldFetchImageInlineFallback(
  att: Pick<MessageAttachment, "localPreviewUrl" | "thumbnailUrl" | "rasterPreviewUrl">,
): boolean {
  return !att.localPreviewUrl && !att.thumbnailUrl && !att.rasterPreviewUrl;
}

export function buildImageInlineFallbackKey(
  attachments: readonly MessageAttachment[] | null | undefined,
): string {
  return (attachments ?? [])
    .filter((att) =>
      isPreviewableImageAttachment(att) &&
      !isOptimisticAttachment(att) &&
      shouldFetchImageInlineFallback(att)
    )
    .map((att) => att.id)
    .join("|");
}

export function splitImageInlineFallbackKey(key: string): string[] {
  return key ? key.split("|") : [];
}

export function getImageGalleryPreviewSrc(
  att: ImageGalleryPreviewSource,
  fallbackUrls: Record<string, string>,
): string | undefined {
  return att.localPreviewUrl || att.thumbnailUrl || att.rasterPreviewUrl || fallbackUrls[att.id];
}

export function shouldRenderImageAsAttachmentChip(
  att: ImageGalleryPreviewSource,
  fallbackUrls: Record<string, string>,
): boolean {
  return !getImageGalleryPreviewSrc(att, fallbackUrls);
}

export function retainImageInlineFallbackUrls(
  current: Record<string, string>,
  attachmentIds: readonly string[],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const id of attachmentIds) {
    if (current[id]) next[id] = current[id];
  }
  return Object.keys(next).length === Object.keys(current).length ? current : next;
}

export function setImageInlineFallbackUrl(
  current: Record<string, string>,
  attachmentId: string,
  url: string,
): Record<string, string> {
  return current[attachmentId] === url ? current : { ...current, [attachmentId]: url };
}

export function removeImageInlineFallbackUrl(
  current: Record<string, string>,
  attachmentId: string,
): Record<string, string> {
  if (!current[attachmentId]) return current;
  const { [attachmentId]: _removed, ...next } = current;
  return next;
}
