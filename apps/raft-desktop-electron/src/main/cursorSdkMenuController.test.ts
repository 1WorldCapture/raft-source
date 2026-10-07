import assert from "node:assert/strict";
import test from "node:test";
import {
  CursorSdkMenuController,
  isCursorSdkLoginUrl,
  type CursorSdkMenuDependencies,
  type CursorSdkMenuDialog,
} from "./cursorSdkMenuController.js";

function harness(choices: number[] = [0]) {
  const dialogs: CursorSdkMenuDialog[] = [];
  const urls: string[] = [];
  const requests: Parameters<CursorSdkMenuDependencies["connect"]>[0][] = [];
  let disconnects = 0;
  const deps: CursorSdkMenuDependencies = {
    status: async () => ({ state: "ready", detail: "Saved SDK login" }),
    connect: async (input) => { requests.push(input); return { state: "ready" }; },
    disconnect: async () => { disconnects += 1; },
    showMessage: async (input) => { dialogs.push(input); return choices.shift() ?? 0; },
    openExternal: async (url) => { urls.push(url); },
  };
  return { deps, dialogs, urls, requests, disconnects: () => disconnects };
}

test("Cursor login URL allowlist excludes attacker origins, credentials, verifier and non-web schemes", () => {
  assert.equal(isCursorSdkLoginUrl("https://cursor.com/loginDeepControl?challenge=fixture&uuid=test"), true);
  for (const value of [
    "http://cursor.com/loginDeepControl",
    "https://cursor.com.evil.test/loginDeepControl",
    "https://user:pass@cursor.com/loginDeepControl",
    "https://cursor.com:8443/loginDeepControl",
    "https://cursor.com/other",
    "https://cursor.com/loginDeepControl?verifier=fixture",
    "file:///tmp/test",
    "javascript:alert(1)",
  ]) assert.equal(isCursorSdkLoginUrl(value), false, value);
});

test("Connect defaults to reuse and never opens a browser itself", async () => {
  const h = harness([0]);
  await new CursorSdkMenuController(h.deps).connect();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].browser, false);
  assert.deepEqual(h.urls, []);
  assert.ok(h.dialogs.some((dialog) => dialog.message === "Connection: ready"));
});

test("Browser login opens only the provider URL without printing it into dialogs", async () => {
  const h = harness([1]);
  const url = "https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture";
  h.deps.connect = async (input) => {
    assert.equal(input.browser, true);
    input.onLoginUrl(url);
    return { state: "ready" };
  };
  await new CursorSdkMenuController(h.deps).connect();
  assert.deepEqual(h.urls, [url]);
  assert.equal(JSON.stringify(h.dialogs).includes("challenge=fixture"), false);
});

test("Invalid authorization URL aborts the transaction and cannot open an external page", async () => {
  const h = harness([1]);
  h.deps.connect = async (input) => {
    input.onLoginUrl("https://untrusted.invalid/login");
    assert.equal(input.signal.aborted, true);
    return { state: "ready" };
  };
  await new CursorSdkMenuController(h.deps).connect();
  assert.deepEqual(h.urls, []);
  assert.equal(h.dialogs.some((dialog) => dialog.message === "Connection: ready"), false);
});

test("Pending sign-in is single-flight and explicit cancel suppresses success", async () => {
  const h = harness([1]);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  h.deps.connect = async (input) => {
    calls += 1;
    entered();
    return new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(new Error("fixture-secret")), { once: true }));
  };
  const controller = new CursorSdkMenuController(h.deps);
  const pending = controller.connect();
  await started;
  await controller.connect();
  assert.equal(calls, 1);
  controller.cancelLogin();
  await pending;
  assert.equal(JSON.stringify(h.dialogs).includes("fixture-secret"), false);
  assert.equal(h.dialogs.some((dialog) => dialog.message === "Connection: ready"), false);
});

test("Provider failures never leak their raw message into native dialogs", async () => {
  const h = harness();
  h.deps.status = async () => { throw new Error("fixture-secret-auth-value"); };
  await new CursorSdkMenuController(h.deps).showStatus();
  assert.equal(h.dialogs[0].type, "error");
  assert.equal(JSON.stringify(h.dialogs).includes("fixture-secret-auth-value"), false);
});

test("Disconnect requires explicit confirmation and explains shared login preservation", async () => {
  const h = harness([0, 1]);
  const controller = new CursorSdkMenuController(h.deps);
  await controller.disconnect();
  assert.equal(h.disconnects(), 0);
  await controller.disconnect();
  assert.equal(h.disconnects(), 1);
  assert.match(h.dialogs[0].detail ?? "", /does not sign out Cursor CLI/);
});
