import { describe, expect, it } from "vitest";
import { SVG_NATIVE_RENDER_MAX_BYTES, isPreviewableImageAttachment } from "../src/components/message/urlImageFallback";
import type { MessageAttachment } from "../src/store/messageStore";

function attachment(overrides: Partial<MessageAttachment>): MessageAttachment {
  return {
    id: "att-1",
    filename: "file.svg",
    mimeType: "image/svg+xml",
    sizeBytes: 0,
    ...overrides,
  } as MessageAttachment;
}

describe("isPreviewableImageAttachment (SVG native rendering)", () => {
  it("treats svg as previewable even without thumbnail or raster preview", () => {
    expect(isPreviewableImageAttachment(attachment({}))).toBe(true);
  });

  it("treats svg with a raster preview as previewable", () => {
    expect(isPreviewableImageAttachment(attachment({ rasterPreviewUrl: "https://cdn/a.webp" }))).toBe(true);
  });

  it("keeps oversize svg out of the gallery", () => {
    expect(isPreviewableImageAttachment(attachment({ sizeBytes: SVG_NATIVE_RENDER_MAX_BYTES }))).toBe(true);
    expect(isPreviewableImageAttachment(attachment({ sizeBytes: SVG_NATIVE_RENDER_MAX_BYTES + 1 }))).toBe(false);
  });

  it("still excludes non-image types", () => {
    expect(isPreviewableImageAttachment(attachment({ mimeType: "application/pdf", filename: "a.pdf" }))).toBe(false);
  });
});
