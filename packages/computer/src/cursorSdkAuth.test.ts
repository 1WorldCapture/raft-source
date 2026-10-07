// Presenter tests for `raft-computer cursor-sdk login|status|logout` (AUTH
// worker minimal CLI wiring): the owner surface gets the login URL, the
// borrowed-login guarantee, and secret-free failures. Broker is injected —
// no daemon build, no network, no real Cursor account.

import assert from "node:assert/strict";
import { test } from "vitest";
import { runCursorSdkLogin, runCursorSdkLogout, runCursorSdkStatus } from "./cursorSdkAuth.js";
import type { CursorRuntimeAuthBroker } from "./services/runtimeAuth.js";
import type { CursorRuntimeAuthDeps } from "./services/runtimeAuth.js";

function captureStdout(): { lines(): string[]; restore(): void } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return {
    lines: () => chunks.join("").split("\n").filter((line) => line.length > 0),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function brokerWith(overrides: Partial<CursorRuntimeAuthBroker> = {}): CursorRuntimeAuthBroker {
  return {
    async loginCursorSdkOwner(_input, options) {
      options?.onEvent?.({ kind: "login-url", url: "https://cursor.sh/cli-login?token=presenter-test" });
      return {
        principalId: "123456",
        connectionId: "csdk_abcdef0123456789abcdef01",
        generation: 1,
        backendUrl: "https://api2.cursor.sh",
        email: "user@example.com",
      };
    },
    async getCursorSdkAuthStatus() {
      return {
        status: "bound",
        source: "cursor_sdk_store",
        borrowed: true,
        principalId: "123456",
        connectionId: "csdk_abcdef0123456789abcdef01",
        generation: 2,
        backendUrl: "https://api2.cursor.sh",
        email: "user@example.com",
        apiKeyExpiresAtMs: 4102444800000,
      };
    },
    async logoutCursorSdkOwner() {
      return { status: "cleared", sdkLoginPreserved: true, sdkStorePath: "/tmp/fake-sdk/auth.json" };
    },
    ...overrides,
  } as CursorRuntimeAuthBroker;
}

const deps = (broker: CursorRuntimeAuthBroker): CursorRuntimeAuthDeps => ({ broker });

test("login presenter prints the owner URL and the borrowed-login note", async () => {
  const out = captureStdout();
  try {
    const opened: string[] = [];
    await runCursorSdkLogin({ openUrl: (url) => opened.push(url), deps: deps(brokerWith()) });
    const text = out.lines().join("\n");
    assert.ok(text.includes("https://cursor.sh/cli-login?token=presenter-test"));
    assert.ok(text.includes("open this link"));
    assert.ok(text.includes("Cursor user 123456"));
    assert.ok(text.includes("not changed"), "borrowed-login guarantee present");
    assert.deepEqual(opened, ["https://cursor.sh/cli-login?token=presenter-test"]);
  } finally {
    out.restore();
  }
});

test("status presenter summarizes the binding and the borrowed source", async () => {
  const out = captureStdout();
  try {
    await runCursorSdkStatus(deps(brokerWith()));
    const text = out.lines().join("\n");
    assert.ok(text.includes("bound to Cursor user 123456 (user@example.com)"));
    assert.ok(text.includes("borrowed read-only"), "status names the source semantics");
    assert.ok(text.includes("generation 2"));
    assert.ok(text.includes("borrowed"));
    assert.ok(!/crsr_/.test(text), "no key material on stdout");
  } finally {
    out.restore();
  }
});

test("status presenter covers the not-yet-bound and missing-login states", async () => {
  const out = captureStdout();
  try {
    await runCursorSdkStatus(deps(brokerWith({
      async getCursorSdkAuthStatus() {
        return { status: "unbound", source: "cursor_sdk_store", borrowed: true };
      },
    })));
    await runCursorSdkStatus(deps(brokerWith({
      async getCursorSdkAuthStatus() {
        return { status: "login_missing", source: "cursor_sdk_store", borrowed: true };
      },
    })));
    const text = out.lines().join("\n");
    assert.ok(text.includes("not bound to it yet"));
    assert.ok(text.includes("no Cursor SDK login found"));
    assert.ok(text.includes("raft-computer runtime auth login cursor"));
  } finally {
    out.restore();
  }
});

test("logout presenter states the SDK login was untouched", async () => {
  const out = captureStdout();
  try {
    await runCursorSdkLogout(deps(brokerWith()));
    const text = out.lines().join("\n");
    assert.ok(text.includes("Disconnected this machine's Cursor runtime binding"));
    assert.ok(text.includes("/tmp/fake-sdk/auth.json"));
    assert.ok(text.includes("left untouched"));
  } finally {
    out.restore();
  }
});
