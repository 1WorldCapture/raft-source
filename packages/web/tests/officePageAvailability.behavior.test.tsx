import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import OfficePage from "../src/office/OfficePage";
import { TestIntlProvider } from "./helpers/intl";
import { useServerStore } from "../src/store/serverStore";

// M3 acceptance finding #4: the members Office view said "The office could not
// be loaded." on the Go server, whose GET /api/servers/{id}/agent-overview
// answers an explicit 501 feature_not_implemented. The honest rejection must
// read as "not enabled on this server", not as a malfunction — while any
// other failure (including a generic 404, which is ambiguous) keeps the
// could-not-load copy.

const originalGet = api.get.bind(api);

function seedServer(id: string) {
  useServerStore.setState({
    current: {
      id,
      name: `Office Server ${id}`,
      avatarUrl: null,
      slug: `office-server-${id}`,
      ownerId: "user-owner",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-06-28T00:00:00.000Z",
    },
    members: [],
  } as never);
}

function notEnabledError() {
  return {
    response: {
      status: 501,
      data: { error: "Office overview is not enabled in this server stage", code: "feature_not_implemented" },
    },
  };
}

function renderOfficePage() {
  return render(
    <MemoryRouter>
      <TestIntlProvider>
        <OfficePage />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  api.get = originalGet as typeof api.get;
  useServerStore.setState({ current: null, members: [] } as never);
});

test("explicit 501 shows the not-enabled message", async () => {
  seedServer("server-office");
  api.get = (async () => {
    throw notEnabledError();
  }) as typeof api.get;

  renderOfficePage();

  const notice = await screen.findByTestId("office-unavailable");
  assert.equal(notice.textContent, "The office view is not enabled on this server.");
});

test("a generic 404 keeps the could-not-load copy as a real error", async () => {
  seedServer("server-office");
  api.get = (async () => {
    // Ambiguous route-miss body: missing resource / proxy / typo — never a
    // not-enabled signal.
    throw { response: { status: 404, data: { error: "Not found" } } };
  }) as typeof api.get;

  renderOfficePage();

  assert.ok(await screen.findByTestId("office-error"));
  assert.equal(screen.queryByTestId("office-unavailable"), null);
});

test("genuine overview failures keep the could-not-load copy", async () => {
  seedServer("server-office");
  api.get = (async () => {
    throw new Error("network down");
  }) as typeof api.get;

  renderOfficePage();

  const error = await screen.findByTestId("office-error");
  assert.equal(screen.queryByTestId("office-unavailable"), null);
  assert.equal(error.textContent, "The office could not be loaded.");
});

test("clearing the workspace removes its scoped notice without an unscoped request", async () => {
  let calls = 0;
  seedServer("server-deferred");
  api.get = (async () => {
    calls += 1;
    throw notEnabledError();
  }) as typeof api.get;

  renderOfficePage();
  await screen.findByTestId("office-unavailable");
  const callsBeforeClear = calls;

  await act(async () => {
    useServerStore.setState({ current: null, members: [] } as never);
  });

  assert.equal(screen.queryByTestId("office-unavailable"), null);
  assert.equal(screen.queryByTestId("office-roster"), null);
  assert.equal(calls, callsBeforeClear);
});

// Workspace switch: the scoped status must follow the NEW workspace. A
// previous workspace's overview and its scoped flags are cleared on scope
// entry, so the unavailable notice appears exactly while the current scope
// answers 501 — never as residue of an earlier workspace. (The canvas itself
// cannot mount under jsdom — office assets need real image decoding — so the
// stale-canvas unmount is structurally guaranteed by clearing `overview`,
// which the scene memo and canvas subtree derive from.)
test("switching workspaces resets the scoped overview status for the new scope", async () => {
  const overview = {
    serverTime: 1_000,
    agents: [],
    machines: [],
  };
  api.get = (async (url: string) => {
    if (url.includes("server-enabled")) return { data: overview };
    throw notEnabledError();
  }) as typeof api.get;

  seedServer("server-enabled");
  renderOfficePage();

  // Enabled workspace: no scoped notice.
  await waitFor(() => assert.ok(api.get));
  assert.equal(screen.queryByTestId("office-unavailable"), null);

  // Switch to a workspace whose overview answers 501.
  await act(async () => {
    seedServer("server-deferred");
  });
  const deferredNotice = await screen.findByTestId("office-unavailable");
  assert.equal(deferredNotice.textContent, "The office view is not enabled on this server.");

  // Switch back to an enabled workspace: the notice must clear with the scope.
  await act(async () => {
    seedServer("server-enabled-2");
  });
  api.get = (async () => ({ data: overview })) as typeof api.get;
  await waitFor(() => {
    assert.equal(screen.queryByTestId("office-unavailable"), null);
  });
});
