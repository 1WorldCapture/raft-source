import type { MessageAttachment } from "../model/messages";

/** Native SVG rendering cap: expo-image (AndroidSVG) parses SVG in image mode
 *  (no script execution, no external resource loading), but huge or malformed
 *  files can still stall the decoder, so oversized SVGs fall back to the
 *  generic "cannot preview, share instead" path. */
export const SVG_NATIVE_RENDER_MAX_BYTES = 2 * 1024 * 1024;

export function isSvgAttachment(attachment: Pick<MessageAttachment, "filename" | "mimeType">): boolean {
  if (attachment.mimeType?.toLowerCase() === "image/svg+xml") return true;
  return attachment.filename.toLowerCase().endsWith(".svg");
}

/** Unknown size renders: nearly all real SVGs are far below the cap and the
 *  sizeBytes field can be missing on older messages. */
export function canRenderSvgNatively(attachment: Pick<MessageAttachment, "filename" | "mimeType" | "sizeBytes">): boolean {
  if (!isSvgAttachment(attachment)) return false;
  if (attachment.sizeBytes == null) return true;
  return attachment.sizeBytes <= SVG_NATIVE_RENDER_MAX_BYTES;
}
