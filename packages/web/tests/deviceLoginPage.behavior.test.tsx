import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import api from "../src/api/client";
import DeviceLoginPage from "../src/pages/DeviceLoginPage";
import { useAuthStore } from "../src/store/authStore";
// DeviceLoginPage now calls useIntl() (pages.deviceLogin.* migration), so it
// needs an <IntlProvider> ancestor. Default locale (en) keeps these English
// assertions green.
import { TestIntlProvider } from "./helpers/intl";

const originalPost = api.post;
const originalClose = window.close;

function resetAuthUser() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "cindy@example.com",
      gravatarHash: "",
      name: "cindy zhao",
      displayName: "cindy zhao",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
}

async function submitWithError(code: string) {
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  resetAuthUser();
  api.post = async () => {
    throw { response: { data: { code } } };
  };

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve Device Login" }));
  });
}

afterEach(() => {
  cleanup();
  api.post = originalPost;
  window.close = originalClose;
  window.history.pushState({}, "", "/");
  resetAuthUser();
});

test("expired device login points users back to Raft Desktop sign-in", async () => {
  await submitWithError("expired");

  assert.ok(await screen.findByText("That code has expired. Start sign-in again from Raft Desktop."));
  assert.equal(screen.queryByText(/raft-computer login/), null);
});

test("invalid device login references the code shown in Raft Desktop", async () => {
  await submitWithError("user_code_invalid");

  assert.ok(await screen.findByText("That code is invalid. Check the code shown in Raft Desktop and try again."));
});

test("already-used device login points users back to Raft Desktop if needed", async () => {
  await submitWithError("already_resolved");

  assert.ok(await screen.findByText("That sign-in request was already used. Start sign-in again from Raft Desktop if needed."));
});

test("approved device login closes the browser page from the Raft Desktop return state", async () => {
  let closed = false;
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  window.close = () => {
    closed = true;
  };
  resetAuthUser();
  api.post = async () => ({ data: {} });

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve Device Login" }));
  });

  assert.ok(await screen.findByText("Sign-in is complete. You can close this browser page."));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close this page" }));
  });

  await waitFor(() => assert.equal(closed, true));
  assert.ok(await screen.findByText("If this tab stays open, close it manually."));
});

test("denying device login posts approve:false and shows the denied return state", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  window.history.pushState({}, "", "/login/device?user_code=vswa-7m58");
  resetAuthUser();
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: { ok: true, action: "denied" } };
  }) as typeof api.post;

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  });

  assert.deepEqual(posts, [{
    url: "/auth/device/approve",
    body: { userCode: "VSWA-7M58", approve: false },
  }]);
  assert.ok(await screen.findByText("Device login denied"));
  assert.ok(await screen.findByText("The sign-in request was denied. You can close this browser page."));
  // The code input is gone once a decision has been made.
  assert.equal(screen.queryByPlaceholderText("XXXX-XXXX"), null);
});

test("denied device login keeps the close-page affordance shared with approval", async () => {
  let closed = false;
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  window.close = () => {
    closed = true;
  };
  resetAuthUser();
  api.post = async () => ({ data: { ok: true, action: "denied" } });

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close this page" }));
  });

  await waitFor(() => assert.equal(closed, true));
  assert.ok(await screen.findByText("If this tab stays open, close it manually."));
});

test("only the selected action shows its in-flight label; both stay disabled", async () => {
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  resetAuthUser();
  let resolvePost: (() => void) = () => {};
  api.post = () => new Promise((resolve) => {
    resolvePost = () => resolve({ data: { ok: true } });
  }) as typeof api.post;

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve Device Login" }));
  });

  // Approve is the action in flight: it alone shows "Approving…".
  const approveButton = screen.getByRole("button", { name: "Approving…" }) as HTMLButtonElement;
  assert.equal(approveButton.disabled, true);
  // Deny keeps its resting label while still disabled — not "Denying…".
  const denyButton = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
  assert.equal(denyButton.disabled, true);
  assert.equal(screen.queryByRole("button", { name: "Denying…" }), null);

  await act(async () => {
    resolvePost();
  });
  assert.ok(await screen.findByText("Sign-in is complete. You can close this browser page."));
});

test("same-tick double submission issues exactly one POST", async () => {
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  resetAuthUser();
  const posts: unknown[] = [];
  let resolvePost: (() => void) = () => {};
  api.post = (() => new Promise((resolve) => {
    posts.push(Date.now());
    resolvePost = () => resolve({ data: { ok: true } });
  })) as typeof api.post;

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    // Two clicks inside one tick, before the disabled state can flush.
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  });

  assert.equal(posts.length, 1);
  await act(async () => {
    resolvePost();
  });
  assert.ok(await screen.findByText("Device login denied"));
});

test("a landed decision is terminal: the form is gone and nothing can resubmit", async () => {
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  resetAuthUser();
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: { ok: true } };
  }) as typeof api.post;

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  });
  await screen.findByText("Device login denied");

  // The decision view replaced the form: no submission affordance remains.
  assert.equal(screen.queryByRole("button", { name: "Deny" }), null);
  assert.equal(screen.queryByRole("button", { name: "Approve Device Login" }), null);
  assert.equal(screen.queryByPlaceholderText("XXXX-XXXX"), null);
  assert.deepEqual(posts.map((post) => post.body), [{ userCode: "VSWA-7M58", approve: false }]);
});

test("denial failures reuse the shared code-lifecycle error copy", async () => {
  await submitDenyWithError("expired");
  assert.ok(await screen.findByText("That code has expired. Start sign-in again from Raft Desktop."));
});

async function submitDenyWithError(code: string) {
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  resetAuthUser();
  api.post = async () => {
    throw { response: { data: { code } } };
  };

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  });
}
