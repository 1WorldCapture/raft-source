import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import apiClient from "../src/api/client";
import AgentSkills from "../src/components/agent/AgentSkills";
import { TestIntlProvider } from "./helpers/intl";

// M3 acceptance finding #3: the Agent detail panel showed a bare "Not found"
// + Retry between "Created Agents" and "Actions" — that block is AgentSkills,
// whose GET /api/agents/{id}/skills is a route miss on the Go server (the TS
// server relays it over the daemon WebSocket, an M4 surface). When the server
// answers honestly that the surface does not exist, the panel must say so
// without a retry loop; genuine errors keep the retryable banner.

const originalGet = apiClient.get.bind(apiClient);

afterEach(() => {
  cleanup();
  apiClient.get = originalGet as typeof apiClient.get;
});

test("explicit 501 renders the not-enabled state without a Retry button", async () => {
  apiClient.get = (async () => {
    // The Go deferred endpoint's machine-readable contract.
    throw {
      response: {
        status: 501,
        data: { error: "Agent skills are not enabled in this server stage", code: "feature_not_implemented" },
      },
    };
  }) as typeof apiClient.get;

  render(<TestIntlProvider><AgentSkills agentId="agent-1" embedded /></TestIntlProvider>);

  assert.ok(await screen.findByText("Skills are not available from this server."));
  assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
});

test("a generic 404 stays a retryable error, never the not-enabled state", async () => {
  // A 404 is ambiguous (missing resource / proxy misroute / typo'd path) on
  // every backend shape — including the Go and TS catch-all bodies — and must
  // keep the error + Retry path.
  for (const data of [{ error: "Not found" }, { error: "Not found", code: "not_found", path: "/api/agents/agent-1/skills" }]) {
    apiClient.get = (async () => {
      throw { response: { status: 404, data } };
    }) as typeof apiClient.get;

    render(<TestIntlProvider><AgentSkills agentId="agent-1" embedded /></TestIntlProvider>);

    assert.ok(await screen.findByText("Not found"));
    assert.ok(screen.getByRole("button", { name: "Retry" }));
    assert.equal(screen.queryByText("Skills are not available from this server."), null);
    cleanup();
  }
});

test("semantic 404 (Agent not found) keeps the error and Retry path", async () => {
  apiClient.get = (async () => {
    // The TS server answers this body when the agent itself is missing.
    throw { response: { status: 404, data: { error: "Agent not found" } } };
  }) as typeof apiClient.get;

  render(<TestIntlProvider><AgentSkills agentId="agent-1" embedded /></TestIntlProvider>);

  assert.ok(await screen.findByText("Agent not found"));
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

test("retry after a genuine error can still reach the not-enabled state", async () => {
  let calls = 0;
  apiClient.get = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    throw {
      response: {
        status: 501,
        data: { error: "Agent skills are not enabled in this server stage", code: "feature_not_implemented" },
      },
    };
  }) as typeof apiClient.get;

  render(<TestIntlProvider><AgentSkills agentId="agent-1" embedded /></TestIntlProvider>);

  const retry = await screen.findByRole("button", { name: "Retry" });
  await waitFor(() => assert.ok(retry));
  fireEvent.click(retry);

  assert.ok(await screen.findByText("Skills are not available from this server."));
  assert.equal(calls, 2);
});
