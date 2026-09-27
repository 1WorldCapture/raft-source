// Renderer-side derivation: given the main process's converge outcome, what
// does the This Computer card show and which single recovery action does it
// offer? Pinned: null while pending/ok (old hosts and healthy takeovers render
// exactly as before), recycle for version skew, start-only retry after a
// recycle that stopped the service but failed to start the successor, generic
// converge retry otherwise.
import assert from "node:assert/strict";
import test from "node:test";

import { deriveConvergeNotice } from "./thisComputerLogic";

test("no notice while pending or healthy (byte-stable for old hosts)", () => {
  assert.equal(deriveConvergeNotice(undefined), null);
  assert.equal(deriveConvergeNotice({ ok: true }), null);
});

test("version skew offers the disruptive stop→start recycle", () => {
  for (const code of ["SERVICE_VERSION_SKEW", "SERVICE_VERSION_SKEW_SUSPECT"]) {
    const notice = deriveConvergeNotice({ ok: false, code, message: "A Raft Computer service from version 1.0.28 is already running…" });
    assert.equal(notifyAction(notice), "recycle", code);
    assert.match(notice!.message, /not hosted by this app/);
    assert.match(notice!.message, /1\.0\.28/);
  }
});

test("a recycle whose start failed offers start-only retry (never a second stop)", () => {
  const notice = deriveConvergeNotice({ ok: false, code: "RECYCLE_START_FAILED", message: "Stopped the old service, but starting the new one failed: boom" });
  assert.equal(notifyAction(notice), "start");
  assert.match(notice!.message, /starting the new one failed/);
});

test("everything else offers a generic converge retry", () => {
  for (const converge of [
    { ok: false, code: "HOST_LIFECYCLE_APP_READBACK_FAILED", message: "x" },
    { ok: false, code: undefined, message: undefined },
    { ok: false, message: "codeless" },
  ] as const) {
    const notice = deriveConvergeNotice(converge);
    assert.equal(notifyAction(notice), "retry-converge");
    assert.ok(notice!.message.length > 0);
  }
});

function notifyAction(notice: ReturnType<typeof deriveConvergeNotice>): string | null {
  return notice?.action ?? null;
}
