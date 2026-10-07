// Service-seam tests for the Cursor SDK runtime-auth Computer service:
// event adaptation, typed-error mapping, daemon-unavailable fallback, and
// the borrowed-login preservation contract surfaced to owners. The broker
// is always injected — no daemon build, no network, no real account.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  cursorRuntimeAuthLogin,
  cursorRuntimeAuthLogout,
  cursorRuntimeAuthStatus,
  type CursorRuntimeAuthBroker,
} from "./runtimeAuth.js";
import { ComputerServiceError } from "./errors.js";
import type { ComputerApiEvent } from "../lib/events.js";

class FakeBroker implements CursorRuntimeAuthBroker {
  calls: string[] = [];
  loginEvents: { kind: "login-url"; url: string }[] = [
    { kind: "login-url", url: "https://cursor.sh/cli-login?token=fake" },
  ];
  failWith: (call: string) => Error | null = () => null;
  statusResult: Awaited<ReturnType<CursorRuntimeAuthBroker["getCursorSdkAuthStatus"]>> = {
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
  loginResult: Awaited<ReturnType<CursorRuntimeAuthBroker["loginCursorSdkOwner"]>> = {
    principalId: "123456",
    connectionId: "csdk_abcdef0123456789abcdef01",
    generation: 1,
    backendUrl: "https://api2.cursor.sh",
    email: "user@example.com",
  };
  logoutResult: Awaited<ReturnType<CursorRuntimeAuthBroker["logoutCursorSdkOwner"]>> = {
    status: "cleared",
    sdkLoginPreserved: true,
    sdkStorePath: "/tmp/fake/auth.json",
  };

  private check(call: string): void {
    this.calls.push(call);
    const failure = this.failWith(call);
    if (failure) throw failure;
  }

  async loginCursorSdkOwner(input: { slockHome: string }, options: { signal?: AbortSignal; onEvent?: (event: { kind: "login-url"; url: string }) => void }) {
    this.check(`login:${input.slockHome}`);
    for (const event of this.loginEvents) options?.onEvent?.(event);
    if (options?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return this.loginResult;
  }

  async getCursorSdkAuthStatus(input: { slockHome: string }) {
    this.check(`status:${input.slockHome}`);
    return this.statusResult;
  }

  async logoutCursorSdkOwner(input: { slockHome: string }) {
    this.check(`logout:${input.slockHome}`);
    return this.logoutResult;
  }
}

test("login adapts the broker's login-url into the ComputerApi event surface", async () => {
  const broker = new FakeBroker();
  const events: ComputerApiEvent[] = [];
  const result = await cursorRuntimeAuthLogin(
    { slockHome: "/tmp/home" },
    { onEvent: (event) => events.push(event) },
    { broker },
  );
  assert.equal(result.principalId, "123456");
  assert.deepEqual(events, [{ kind: "cursor-sdk.login-url", url: "https://cursor.sh/cli-login?token=fake" }]);
  assert.deepEqual(broker.calls, ["login:/tmp/home"]);
});

test("status and logout pass through the broker results verbatim", async () => {
  const broker = new FakeBroker();
  const status = await cursorRuntimeAuthStatus({ slockHome: "/tmp/home" }, { broker });
  assert.equal(status.status, "bound");
  assert.equal(status.borrowed, true);
  assert.equal(status.generation, 2);
  const logout = await cursorRuntimeAuthLogout({ slockHome: "/tmp/home" }, { broker });
  assert.equal(logout.status, "cleared");
  assert.equal(logout.sdkLoginPreserved, true);
});

test("typed CURSOR_SDK_* broker errors re-throw as ComputerServiceError with the same code", async () => {
  const broker = new FakeBroker();
  broker.failWith = () => Object.assign(new Error("The saved Cursor SDK login was rejected (credential rejected)."), {
    code: "CURSOR_SDK_LOGIN_INVALID",
  });
  await assert.rejects(
    () => cursorRuntimeAuthStatus({ slockHome: "/tmp/home" }, { broker }),
    (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "CURSOR_SDK_LOGIN_INVALID");
      assert.ok(err.message.includes("rejected"));
      return true;
    },
  );
  // AbortErrors pass through untouched (callers coordinate cancellation).
  broker.failWith = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(
    () => cursorRuntimeAuthStatus({ slockHome: "/tmp/home" }, { broker }),
    (err: unknown) => (err as Error).name === "AbortError",
  );
});

test("a missing daemon core surfaces as RAFT_DAEMON_UNAVAILABLE, not a raw import error", async () => {
  await assert.rejects(
    () =>
      cursorRuntimeAuthStatus(
        { slockHome: "/tmp/home" },
        { loadBroker: async () => { throw new Error("Cannot find module '@botiverse/raft-daemon/core'"); } },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "RAFT_DAEMON_UNAVAILABLE");
      assert.ok(err.message.includes("raft-daemon build"));
      return true;
    },
  );
  // Non-typed broker faults (programming errors) propagate unchanged so
  // they stay diagnosable instead of being flattened into a domain error.
  const broker = new FakeBroker();
  broker.failWith = () => new TypeError("broker exploded");
  await assert.rejects(
    () => cursorRuntimeAuthStatus({ slockHome: "/tmp/home" }, { broker }),
    (err: unknown) => err instanceof TypeError,
  );
});
