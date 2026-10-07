// D3 regression guard (task #13 acceptance): the settings download section
// must appear on a private deployment whose deployment-info carries desktop
// artifacts — verified END TO END without mocking the hook: a stubbed fetch
// flows through the real parseDeploymentInfo into the real
// useDeploymentDownloads store and renders the real component. Before the
// fix, parseDeploymentInfo silently dropped the desktop field and this
// section could never render.
//
// The stubbed links are http://localhost:3000 because jsdom's page origin
// (the API-origin fallback when nothing is compiled in) is exactly that —
// same-origin with the deployment is the acceptance rule, and scheme follows
// the deployment's own origin.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import { DesktopDownloadSection } from "../src/components/settings/DesktopDownloadSection";
import { __resetDeploymentModeForTests, ensureDeploymentMode } from "../src/utils/deploymentMode";
import { renderWithIntl } from "./helpers/intl";

const realFetch = globalThis.fetch;

function stubDeploymentInfo(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

// domSetup presets the mode cache to "standard" for legacy behavioral
// tests; every scenario here must start from a clean cache so the stubbed
// fetch actually flows through the real parse.
beforeEach(() => {
  __resetDeploymentModeForTests();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  __resetDeploymentModeForTests();
});

test("a private deployment-info with desktop artifacts renders both chip links from the parsed payload", async () => {
  const arm64 = "http://localhost:3000/downloads/desktop/0.1.10/Raft-Desktop-0.1.10-arm64.dmg";
  const x64 = "http://localhost:3000/downloads/desktop/0.1.10/Raft-Desktop-0.1.10-x64.dmg";
  stubDeploymentInfo({
    deploymentMode: "private",
    downloads: {
      computerBase: "http://localhost:3000/downloads/computer",
      desktop: { version: "0.1.10", dmg: { arm64, x64 } },
    },
  });
  // Real parse path — no hook mock: the fetch above must populate the store.
  await ensureDeploymentMode();
  renderWithIntl(<DesktopDownloadSection />);
  const arm = screen.getByTestId("desktop-download-arm64");
  const intel = screen.getByTestId("desktop-download-x64");
  assert.equal((arm as HTMLAnchorElement).href, arm64);
  assert.equal((intel as HTMLAnchorElement).href, x64);
  // Both chip families are labeled — client arch detection is deliberately
  // not trusted (Safari on Apple Silicon reports "Intel Mac OS X").
  assert.match(arm.textContent ?? "", /Apple/i);
  assert.match(intel.textContent ?? "", /Intel/i);
  assert.ok(screen.getByText(/Raft Desktop 0\.1\.10/), "title carries the parsed version");
});

test("no desktop block in the payload keeps the section hidden — never a guessed URL", async () => {
  stubDeploymentInfo({
    deploymentMode: "private",
    downloads: { computerBase: "http://localhost:3000/downloads/computer" },
  });
  await ensureDeploymentMode();
  const { container } = renderWithIntl(<DesktopDownloadSection />);
  assert.equal(screen.queryByTestId("desktop-download-arm64"), null);
  assert.equal(container.querySelector('[data-testid="desktop-download-section"]'), null);
});

test("a dangerous-scheme desktop link is dropped by the same parse, so nothing renders", async () => {
  stubDeploymentInfo({
    deploymentMode: "private",
    downloads: {
      computerBase: "http://localhost:3000/downloads/computer",
      desktop: {
        version: "0.1.10",
        dmg: {
          arm64: "javascript:alert(1)",
          x64: "http://localhost:3000/downloads/desktop/0.1.10/x64.dmg",
        },
      },
    },
  });
  await ensureDeploymentMode();
  renderWithIntl(<DesktopDownloadSection />);
  assert.equal(screen.queryByTestId("desktop-download-arm64"), null);
  assert.equal(screen.queryByTestId("desktop-download-x64"), null);
});
