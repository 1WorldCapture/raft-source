import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
const { default: api } = await import("../src/api/client");
const {
  fetchSvgPngPreviewUrl,
  getCachedSvgPngPreviewUrl,
  invalidateSvgPngPreview,
} = await import("../src/components/message/svgPngPreview");

const originalApiGet = api.get;

/**
 * Stub the browser rasterization primitives jsdom lacks: an Image that
 * "decodes" from a blob URL with fixed intrinsic size, and a canvas whose
 * 2d context draws nothing and toBlob yields a PNG blob.
 */
let fakeImageDecodeFailures = 0;
let lastSvgObjectUrl = "";

function installRasterStubs(options?: { decodeFailures?: number }): void {
  fakeImageDecodeFailures = options?.decodeFailures ?? 0;
  (globalThis as typeof globalThis & { Image: unknown }).Image = class {
    naturalWidth = 300;
    naturalHeight = 200;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      lastSvgObjectUrl = value;
      if (fakeImageDecodeFailures > 0) {
        fakeImageDecodeFailures -= 1;
        queueMicrotask(() => this.onerror?.());
        return;
      }
      queueMicrotask(() => this.onload?.());
    }
  } as unknown as never;
  const realCreateElement = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    if (tag === "canvas") {
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toBlob: (callback: (blob: Blob | null) => void) => {
          callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
        },
      } as unknown as HTMLCanvasElement;
    }
    return realCreateElement(tag);
  }) as typeof document.createElement;
}

const revokedUrls: string[] = [];
let objectUrlCounter = 0;
const realRevokeObjectURL = URL.revokeObjectURL;
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (() => `blob:mock-${objectUrlCounter++}-png`) as typeof URL.createObjectURL;
URL.revokeObjectURL = ((url: string) => {
  revokedUrls.push(url);
}) as typeof URL.revokeObjectURL;

afterEach(() => {
  api.get = originalApiGet;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  invalidateSvgPngPreview("png-attachment");
  invalidateSvgPngPreview("png-dedupe-attachment");
  invalidateSvgPngPreview("png-fail-attachment");
});

test("rasterizes the SVG bytes to a PNG object URL through the same-origin endpoint", async () => {
  installRasterStubs();
  const requested: string[] = [];
  api.get = (async (url: string) => {
    requested.push(url);
    return { data: new Blob([new Uint8Array([60, 115, 118, 103])], { type: "image/svg+xml" }) };
  }) as typeof api.get;

  const url = await fetchSvgPngPreviewUrl("png-attachment");
  assert.match(url ?? "", /^blob:mock-/);
  assert.deepEqual(requested, ["/attachments/png-attachment?disposition=inline"], "must hit the same-origin bytes endpoint, never the presigned /url route");
  assert.equal(getCachedSvgPngPreviewUrl("png-attachment"), url, "the PNG object URL must be session-cached");
  // The raw SVG blob URL was revoked (never handed to callers), and the
  // exposed URL is the PNG rasterization.
  assert.ok(revokedUrls.includes(lastSvgObjectUrl), "the intermediate SVG object URL must be revoked");
  assert.notEqual(url, lastSvgObjectUrl);
});

test("concurrent and repeat requests reuse one cached PNG preview", async () => {
  installRasterStubs();
  let calls = 0;
  api.get = (async () => {
    calls += 1;
    return { data: new Blob([], { type: "image/svg+xml" }) };
  }) as typeof api.get;

  const [a, b] = await Promise.all([fetchSvgPngPreviewUrl("png-dedupe-attachment"), fetchSvgPngPreviewUrl("png-dedupe-attachment")]);
  assert.equal(a, b);
  assert.equal(calls, 1, "in-flight requests must be shared");

  const again = await fetchSvgPngPreviewUrl("png-dedupe-attachment");
  assert.equal(again, a, "repeat opens must reuse the cached PNG preview");
  assert.equal(calls, 1);
});

test("a failed decode resolves null without caching", async () => {
  installRasterStubs({ decodeFailures: 1 });
  api.get = (async () => ({ data: new Blob([], { type: "image/svg+xml" }) })) as typeof api.get;
  const failed = await fetchSvgPngPreviewUrl("png-fail-attachment");
  assert.equal(failed, null);
  assert.equal(getCachedSvgPngPreviewUrl("png-fail-attachment"), null, "failures must not poison the cache");
});
