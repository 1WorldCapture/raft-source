import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { imageGalleryBackgroundClass, transparentImageBackgroundClass } from "../src/utils/imagePreviewStyles.js";

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

function strykerBackupSrc(): string | null {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
}

function readSource(path: string): string {
  const sourcePath = path.replace(/^src\//, "");
  const backupSrc = strykerBackupSrc();
  const backupPath = backupSrc ? resolve(backupSrc, sourcePath) : null;
  return readFileSync(backupPath && existsSync(backupPath) ? backupPath : resolve(srcRoot, sourcePath), "utf8");
}

test("transparent image previews use a shared checkerboard background class", () => {
  const css = readFileSync(resolve(repoRoot, "src/index.css"), "utf8");

  assert.equal(transparentImageBackgroundClass, "image-transparency-bg");
  assert.match(css, /\.image-transparency-bg\s*\{/);
  assert.match(css, /background-image:/);
});

test("image preview surfaces opt into the transparency background", () => {
  const previewSurfaces = [
    "src/components/message/MessageInput.tsx",
    "src/components/ImageLightbox.tsx",
    "src/components/agent/AgentWorkspace.tsx",
  ];

  for (const surface of previewSurfaces) {
    const source = readSource(surface);
    assert.match(source, /transparentImageBackgroundClass/, `${surface} should use the transparency preview class`);
  }
});

test("message gallery uses a quiet background instead of checkerboard", () => {
  const source = readSource("src/components/message/MessageItem.tsx");
  const css = readSource("src/index.css");

  assert.equal(imageGalleryBackgroundClass, "image-gallery-bg");
  assert.match(source, /imageGalleryBackgroundClass/);
  assert.doesNotMatch(source, /transparentImageBackgroundClass/);
  assert.match(source, /bg-brutal-cream\/60/);
  assert.doesNotMatch(source, /border-2 border-black bg-transparent/);
  assert.match(source, /const imageBackgroundClass = fitClass === "object-contain" \? imageGalleryBackgroundClass : "";/);
  assert.match(css, /\.image-gallery-bg\s*\{[\s\S]*?background:\s*#fff;/);
});

test("image lightbox backdrop and empty image stage close without making image clicks close", () => {
  const source = readSource("src/components/ImageLightbox.tsx");

  // Lightbox primitive owns the backdrop dismiss (dismissOnBackdrop=true by default).
  // ImageLightbox passes onClose={close} to Lightbox.
  assert.match(source, /data-testid="image-lightbox"/);
  assert.match(source, /<Lightbox[\s\S]{0,200}onClose=\{close\}/);
  // Image stage also closes on true visual click-outside. The bounds guard keeps
  // transformed image pixels non-dismissible after zoom/pan.
  assert.match(source, /data-testid="image-lightbox-stage"/);
  assert.match(source, /data-testid="image-lightbox-stage"[\s\S]*?e\.target === e\.currentTarget && !zoom\.containsImagePoint\(e\.clientX,\s*e\.clientY\)/);
  assert.match(source, /data-testid="image-lightbox-image"/);
});

test("SVG attachments render inline: safe raster first, same-origin blob for raster-less files", () => {
  const imageFallback = readSource("src/components/message/urlImageFallback.ts");
  const messageInput = readSource("src/components/message/MessageInput.tsx");
  const lightbox = readSource("src/components/ImageLightbox.tsx");
  const svgPngPreview = readSource("src/components/message/svgPngPreview.ts");

  // Oversize SVGs stay attachment chips (a huge file can stall the decoder).
  assert.match(imageFallback, /mimeType === "image\/svg\+xml"[\s\S]*?SVG_NATIVE_RENDER_MAX_BYTES/);
  assert.match(messageInput, /mimeType !== "image\/svg\+xml"/);
  // With a CDN raster/thumbnail, the lightbox previews it without fetching.
  assert.match(lightbox, /const isRasterOnlyPreview = isSvgAttachment/);
  assert.match(lightbox, /if \(isRasterOnlyPreview\)[\s\S]*?current\.rasterPreviewUrl \|\| current\.thumbnailUrl \|\| current\.localPreviewUrl/);
  assert.match(lightbox, /setFullUrl\(safeRasterUrl \?\? null\)/);
  // Without a raster, the raw file loads as a same-origin blob — the
  // attachment responses' CORP header blocks a cross-origin presigned URL
  // inside `<img>`.
  assert.match(lightbox, /if \(isSvgAttachment && !hasSafeRaster\)[\s\S]*?fetchSvgPngPreviewUrl\(current\.id\)/);
  // The rasterized preview is exported as PNG (never an svg blob URL, whose
  // origin-pinned navigation would execute SVG scripts on our origin), and
  // the raw SVG object URL is revoked before callers see anything.
  assert.match(svgPngPreview, /canvasToPngBlob\(canvas\)/);
  assert.match(svgPngPreview, /canvas\.toBlob\(\(blob\) => resolve\(blob\), "image\/png"\)/);
  assert.match(svgPngPreview, /URL\.revokeObjectURL\(svgUrl\)/);
  // The lightbox download keeps pulling the ORIGINAL file via the server's
  // attachment disposition, never the rasterized PNG.
  assert.match(lightbox, /url\?disposition=attachment/);
});

test("image lightbox falls back to local draft previews when the signed URL image fails", () => {
  const lightbox = readSource("src/components/ImageLightbox.tsx");

  assert.match(lightbox, /const fallbackSrc = current\.thumbnailUrl \|\| current\.localPreviewUrl;/);
  assert.match(lightbox, /const displaySrc = fullUrl \|\| fallbackSrc;/);
  assert.match(lightbox, /if \(fullUrl && fallbackSrc\) \{[\s\S]*?setFullUrl\(null\);[\s\S]*?setError\(false\);[\s\S]*?return;/);
  assert.match(lightbox, /onError=\{handleImageError\}/);
});
