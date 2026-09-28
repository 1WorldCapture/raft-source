import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import { AuthBootstrapStatus } from "../src/App";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Auth batch (Task 8): the single AppShell bootstrap debt literal
// "Restoring session…" must render through react-intl under zh-cn.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const RESTORING_ID = "auth.bootstrap.restoringSession";

afterEach(() => {
  cleanup();
});

function renderZh(view: "loading" | "restoring") {
  return render(
    <TestIntlProvider locale="zh-cn">
      <AuthBootstrapStatus view={view} />
    </TestIntlProvider>,
  );
}

test("catalog pins auth.bootstrap.restoringSession with preserved meaning", () => {
  assert.equal(en[RESTORING_ID], "Restoring session…");
  assert.equal(zh[RESTORING_ID], "正在恢复会话…");
  assert.match(zh[RESTORING_ID], /\p{Script=Han}/u);
});

test("AuthBootstrapStatus restoring view renders zh-cn catalog copy", () => {
  renderZh("restoring");

  assert.ok(screen.getByText("正在恢复会话…"));
  assert.doesNotMatch(document.body.textContent ?? "", /Restoring session/i);
  assert.doesNotMatch(document.body.textContent ?? "", /auth\.bootstrap\./);
});

test("AuthBootstrapStatus loading view still uses common.loading", () => {
  renderZh("loading");

  assert.ok(screen.getByText("加载中…"));
  assert.doesNotMatch(document.body.textContent ?? "", /Restoring session/i);
});

// #desktop-session-restore task #1 — the degraded restore chrome renders through
// react-intl under zh-cn: title, server/last-error rows, hint, and both actions.
// No raw ids or English fallbacks may leak into the rendered body.
import { DegradedRestoreStatus } from "../src/App";
import type { LastRestoreError } from "../src/utils/authRestoreMachine";

function renderDegradedZh(lastRestoreError: LastRestoreError | null) {
  return render(
    <TestIntlProvider locale="zh-cn">
      <DegradedRestoreStatus
        lastRestoreError={lastRestoreError}
        onRetry={() => {}}
        onLogout={() => {}}
      />
    </TestIntlProvider>,
  );
}

test("DegradedRestoreStatus renders the zh-cn degraded chrome with the HTTP error", () => {
  renderDegradedZh({ kind: "http", status: 502, at: 0 });

  assert.ok(screen.getByText("暂时连不上服务器"));
  assert.ok(screen.getByText("HTTP 502"));
  assert.ok(screen.getByText("立即重试"));
  assert.ok(screen.getByText("退出登录"));
  assert.ok(screen.getByText(/请检查网络、VPN\/代理（如 Clash）和 Tailscale/));
  assert.doesNotMatch(document.body.textContent ?? "", /auth\.bootstrap\./);
  assert.doesNotMatch(document.body.textContent ?? "", /Retry now|Sign out|Can't reach/i);
});

test("DegradedRestoreStatus renders the network error copy without a status", () => {
  renderDegradedZh({ kind: "network", at: 0 });

  assert.ok(screen.getByText("网络错误"));
  assert.ok(screen.queryByText(/HTTP \d+/) === null);
});

// The server row must render an ABSOLUTE address (review r1): the web build's
// RUNTIME_API_BASE is the relative "/api", and the card resolves it against
// the page origin instead of showing a bare "/api".
test("DegradedRestoreStatus server row shows the absolute API address", () => {
  renderDegradedZh({ kind: "http", status: 502, at: 0 });

  const expected = new URL("/api", window.location.origin).toString();
  assert.ok(screen.getByText(expected), `expected the card to show ${expected}`);
  assert.ok(screen.queryByText(/^\/api$/) === null, "must not render the bare relative /api");
});
