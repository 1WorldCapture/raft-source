import assert from "node:assert/strict";
import { test } from "vitest";
import { NativeCursorAuthHost, type NativeAuthReply, type NativeAuthRequest } from "./nativeAuthHost.js";
import type { Cursor as CursorClass, SdkLoginOptions } from "@cursor/sdk";

const request = (kind: NativeAuthRequest["kind"], apiKey?: string): NativeAuthRequest => ({ tag: "raft-cursor-auth-ipc", v: 1, requestId: "fixture", kind, apiKey });
function harness() {
  const replies: NativeAuthReply[] = [];
  const keys: string[] = [];
  let loginOptions: SdkLoginOptions | undefined;
  // Cursor is a class with static APIs in the real SDK, not a constructed client.
  class Vendor {
    static async me(options: { apiKey: string }) { keys.push(options.apiKey); return { userId: 17, userEmail: "fixture@example.invalid" }; }
    static models = { list: async (options: { apiKey: string }) => { keys.push(options.apiKey); return [{ id: "default", displayName: "Default" }]; } };
    static auth = { login: async (options: SdkLoginOptions) => { loginOptions = options; options.onLoginUrl?.("https://cursor.com/loginDeepControl?uuid=fixture&challenge=fixture"); return { apiKey: "fixture-owned", apiKeyExpiresAtMs: Date.now() + 60_000 }; } };
  }
  const host = new NativeCursorAuthHost({ cursor: async () => Vendor as unknown as typeof CursorClass, post: (reply) => replies.push(reply) });
  return { host, replies, keys, Vendor, loginOptions: () => loginOptions };
}

test("verification and model list use the explicitly supplied key through exact public APIs", async () => {
  const h = harness();
  await h.host.receive(request("verify", "fixture-exact"));
  assert.equal(h.replies[0].kind, "verified");
  assert.equal(h.replies[0].principalId, "17");
  assert.equal("apiKey" in h.replies[0], false);
  await h.host.receive(request("models", "fixture-exact"));
  assert.deepEqual(h.keys, ["fixture-exact", "fixture-exact", "fixture-exact"]);
  assert.equal(h.replies[1].kind, "models_result");
  assert.deepEqual(h.replies[1].models, [{ id: "default", label: "Default", isDefault: true }]);
});

test("browser login explicitly disables shared-store persistence and verifies the newly minted key", async () => {
  const h = harness();
  await h.host.receive(request("login"));
  assert.equal(h.loginOptions()?.store, null);
  assert.equal(h.loginOptions()?.openBrowser, false);
  assert.ok(h.loginOptions()?.signal);
  assert.equal(h.loginOptions()?.backendUrl, "https://api2.cursor.sh");
  assert.deepEqual(h.keys, ["fixture-owned"]);
  assert.equal(h.replies[0].kind, "login_url");
  assert.equal(h.replies[1].kind, "verified");
  assert.equal(h.replies[1].apiKey, "fixture-owned", "key leaves the host only on its private IPC result");
});

test("missing key fails closed without falling through to the SDK's ambient login", async () => {
  const h = harness();
  await h.host.receive(request("verify"));
  assert.deepEqual(h.keys, []);
  assert.equal(h.replies[0].kind, "invalid");
});

test("arbitrary provider error messages never leave the host", async () => {
  const h = harness();
  h.Vendor.me = async () => { throw new Error("private-secret-value"); };
  await h.host.receive(request("verify", "fixture"));
  assert.equal(h.replies[0].kind, "error");
  assert.equal(JSON.stringify(h.replies).includes("private-secret-value"), false);
});

test("service-account identity is an explicit unsupported preview result", async () => {
  const h = harness();
  h.Vendor.me = async () => ({ userId: undefined, userEmail: "" }) as unknown as Awaited<ReturnType<typeof h.Vendor.me>>;
  await h.host.receive(request("verify", "fixture"));
  assert.equal(h.replies[0].code, "account_unsupported");
});
