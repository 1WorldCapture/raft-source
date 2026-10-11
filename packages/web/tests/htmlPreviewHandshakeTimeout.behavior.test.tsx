import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, render as rtlRender } from "@testing-library/react";
import { vi } from "vitest";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OVERLAY = '[data-message-affordance="attachment-preview-external-links-loading"]';

// Task #28: the bridge handshake never completed on some deployments, and the "preparing" overlay then covered an
// inert frame forever. After PREVIEW_HANDSHAKE_TIMEOUT_MS the preview degrades to a plain interactive frame.
test("the HTML preview drops its 'preparing' overlay and makes the frame interactive when the handshake never completes", async () => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }),
    });
  }
  vi.useFakeTimers();
  const { HtmlAttachmentPreviewModal, PREVIEW_HANDSHAKE_TIMEOUT_MS } = await import("../src/components/message/attachmentPreviewSurfaces");
  render(
    <HtmlAttachmentPreviewModal filename="page.html" url="https://api.example.test/api/attachments/a/html-preview?previewToken=t" onClose={() => {}} onDownload={() => {}} />,
  );
  const frame = document.querySelector("iframe");
  assert.ok(frame, `the preview frame is rendered: ${document.body.innerHTML.slice(0, 400)}`);
  assert.ok(document.querySelector(OVERLAY), "while waiting for the handshake the overlay is shown");
  assert.match(frame.getAttribute("class") ?? "", /pointer-events-none/, "and the frame is inert");
  assert.match(frame.getAttribute("src") ?? "", /acBridgeNonce=/, "the first-load URL already carries the bridge nonce");

  await act(async () => {
    vi.advanceTimersByTime(PREVIEW_HANDSHAKE_TIMEOUT_MS - 1);
  });
  assert.ok(document.querySelector(OVERLAY), "still waiting just before the timeout");
  await act(async () => {
    vi.advanceTimersByTime(2);
  });
  assert.equal(document.querySelector(OVERLAY), null, "the overlay is gone once the handshake times out");
  assert.doesNotMatch(frame.getAttribute("class") ?? "", /pointer-events-none/, "the frame is interactive after the timeout");
});
