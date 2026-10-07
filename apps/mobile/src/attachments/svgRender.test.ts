import assert from "node:assert/strict";
import test from "node:test";
import { SVG_NATIVE_RENDER_MAX_BYTES, canRenderSvgNatively, isSvgAttachment } from "./svgRender.ts";

test("isSvgAttachment detects mime type and extension", () => {
  assert.equal(isSvgAttachment({ filename: "a.svg", mimeType: "image/svg+xml" }), true);
  assert.equal(isSvgAttachment({ filename: "b", mimeType: "image/svg+xml" }), true);
  assert.equal(isSvgAttachment({ filename: "C.SVG", mimeType: undefined }), true);
  assert.equal(isSvgAttachment({ filename: "d.txt", mimeType: "text/plain" }), false);
  assert.equal(isSvgAttachment({ filename: "e.svgz", mimeType: undefined }), false);
});

test("canRenderSvgNatively allows svg at or under the cap and unknown size", () => {
  assert.equal(canRenderSvgNatively({ filename: "a.svg", mimeType: "image/svg+xml", sizeBytes: 0 }), true);
  assert.equal(canRenderSvgNatively({ filename: "a.svg", mimeType: "image/svg+xml", sizeBytes: SVG_NATIVE_RENDER_MAX_BYTES }), true);
  assert.equal(canRenderSvgNatively({ filename: "a.svg", mimeType: "image/svg+xml", sizeBytes: undefined }), true);
});

test("canRenderSvgNatively rejects oversize and non-svg files", () => {
  assert.equal(canRenderSvgNatively({ filename: "a.svg", mimeType: "image/svg+xml", sizeBytes: SVG_NATIVE_RENDER_MAX_BYTES + 1 }), false);
  assert.equal(canRenderSvgNatively({ filename: "big.png", mimeType: "image/png", sizeBytes: 10 }), false);
});
