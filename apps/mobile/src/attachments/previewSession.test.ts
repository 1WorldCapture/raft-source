import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentPreviewResponse } from "@botiverse/raft-shared/src/attachmentPreview.ts";
import { createPreviewCache, createPreviewGate } from "./previewSession.ts";

test("a failed preview flag stays enabled and is not requested again", async () => {
  const gate = createPreviewGate();
  let calls = 0;
  const first = await gate.load(async () => {
    calls += 1;
    throw new Error("offline");
  });
  const second = await gate.load(async () => {
    calls += 1;
    return { enabled: false };
  });
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(calls, 1);
});

test("the preview flag turns on only when the server says enabled is true", async () => {
  const off = createPreviewGate();
  assert.equal(await off.load(async () => ({ enabled: false })), false);
  const missing = createPreviewGate();
  assert.equal(await missing.load(async () => ({})), false);
  const on = createPreviewGate();
  assert.equal(await on.load(async () => ({ enabled: true })), true);
});

test("concurrent preview loads share one request and a failure can be retried", async () => {
  const cache = createPreviewCache();
  let calls = 0;
  const ok: AttachmentPreviewResponse = { status: "ok", data: { kind: "text", text: "hi" } };
  const firstFetch = () => {
    calls += 1;
    return Promise.reject(new Error("offline"));
  };
  await assert.rejects(() => Promise.all([cache.load("a", firstFetch), cache.load("a", firstFetch)]));
  assert.equal(calls, 1);
  const again = await cache.load("a", async () => {
    calls += 1;
    return ok;
  });
  const cached = await cache.load("a", async () => {
    calls += 1;
    return { status: "unsupported" };
  });
  assert.equal(again, ok);
  assert.equal(cached, ok);
  assert.equal(calls, 2);
});
