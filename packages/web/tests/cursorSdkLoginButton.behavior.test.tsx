// Cursor SDK 修复-1: web sign-in button behavior — unauthenticated flow ends
// with onBound (model list refresh), an already-bound machine demands an
// explicit replace confirmation, and non-cursor.com URLs are never opened.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import CursorSdkLoginButton from "../src/components/agent/CursorSdkLoginButton";

const render: typeof rtlRender = (ui) => rtlRender(ui, { wrapper: TestIntlProvider });

const LOGIN_URL = "https://cursor.com/loginDeepControl?state=fixture";

afterEach(() => {
  cleanup();
});

function stubBrowser(opened: string[], confirmResult: boolean) {
  const originalOpen = window.open;
  const originalConfirm = window.confirm;
  window.open = (url: string | URL) => {
    opened.push(String(url));
    return null;
  };
  window.confirm = () => confirmResult;
  return () => {
    window.open = originalOpen;
    window.confirm = originalConfirm;
  };
}

test("unauthenticated: click opens the cursor.com login URL and reports bound via onBound", async (t) => {
  const opened: string[] = [];
  const restore = stubBrowser(opened, false);
  t.after(restore);

  let statusCalls = 0;
  const loginCalls: string[] = [];
  t.mock.method(api, "get", async (url: string) => {
    if (String(url).endsWith("/cursor-sdk/status")) {
      // First call is the replace check (unbound); poll #1 sees the new binding.
      statusCalls += 1;
      return { data: { status: statusCalls === 1 ? "unbound" : "bound", source: "cursor_sdk_store" } };
    }
    return { data: {} };
  });
  t.mock.method(api, "post", async (url: string) => {
    loginCalls.push(String(url));
    return { data: { ok: true, loginUrl: LOGIN_URL, reused: false } };
  });

  let boundCalls = 0;
  render(
    <CursorSdkLoginButton
      serverId="srv-1"
      machineId="mach-1"
      pollIntervalMs={10}
      onBound={() => { boundCalls += 1; }}
    />,
  );

  fireEvent.click(screen.getByTestId("cursor-sdk-login-button"));

  await waitFor(() => assert.equal(boundCalls, 1), { timeout: 2_000 });
  assert.equal(loginCalls.length, 1, "one login POST");
  assert.deepEqual(opened, [LOGIN_URL], "authorization URL opened in the browser");
  await waitFor(() => {
    assert.match(
      screen.getByTestId("cursor-sdk-login-button").textContent ?? "",
      /登录 Cursor|Sign in to Cursor/,
    );
  });
});

test("already bound: without an explicit replace confirmation nothing is sent", async (t) => {
  const opened: string[] = [];
  const restore = stubBrowser(opened, false); // user cancels the replace dialog
  t.after(restore);

  const loginCalls: string[] = [];
  t.mock.method(api, "get", async (url: string) => String(url).endsWith("/cursor-sdk/status")
    ? { data: { status: "bound", source: "raft_owned" } }
    : { data: {} });
  t.mock.method(api, "post", async (url: string) => {
    loginCalls.push(String(url));
    return { data: { ok: true, loginUrl: LOGIN_URL } };
  });

  render(
    <CursorSdkLoginButton serverId="srv-1" machineId="mach-1" pollIntervalMs={10} onBound={() => {}} />,
  );
  fireEvent.click(screen.getByTestId("cursor-sdk-login-button"));

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(loginCalls, [], "cancelled replacement must not start a sign-in");
  assert.deepEqual(opened, [], "nothing opened");
});

test("a non-cursor.com loginUrl is rejected and never opened", async (t) => {
  const opened: string[] = [];
  const restore = stubBrowser(opened, false);
  t.after(restore);

  t.mock.method(api, "get", async (url: string) => String(url).endsWith("/cursor-sdk/status")
    ? { data: { status: "unbound", source: "cursor_sdk_store" } }
    : { data: {} });
  t.mock.method(api, "post", async () => ({
    data: { ok: true, loginUrl: "https://evil.example.com/loginDeepControl" },
  }));

  render(
    <CursorSdkLoginButton serverId="srv-1" machineId="mach-1" pollIntervalMs={10} onBound={() => {}} />,
  );
  fireEvent.click(screen.getByTestId("cursor-sdk-login-button"));

  await waitFor(() => {
    assert.match(screen.getByTestId("cursor-sdk-login-button").textContent ?? "", /登录 Cursor|Sign in to Cursor/);
  }, { timeout: 2_000 });
  assert.ok(opened.length === 0, "untrusted URL must not be opened");
});
