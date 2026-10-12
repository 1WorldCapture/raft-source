import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  asProviderProbeId,
  asProviderProbeRequestId,
} from "@botiverse/raft-shared";
import type { ProviderConnectionSummary, ProviderProbeCreatedView } from "@botiverse/raft-shared";

import api from "../src/api/client";
import { __testInternals } from "../src/components/settings/ProviderConnectionsSettings";
import { useMachineStore } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { TestIntlProvider } from "./helpers/intl";

const { VerifyProviderConnectionModal, VerifiedOnChip, ConnectionRow } = __testInternals;

const CONNECTION_ID = "736b2dc6-dbe6-4733-b1ec-8b52daf25e27";
const MACHINE_ID = "machine-builtin-1";

afterEach(() => {
  cleanup();
  useMachineStore.setState({ machines: [] });
  resetServerFeatureFlagsForTests();
});

function connection(overrides: Partial<ProviderConnectionSummary> = {}): ProviderConnectionSummary {
  return {
    id: CONNECTION_ID,
    name: "Shared DeepSeek",
    providerId: "deepseek",
    authMethod: "api_key",
    endpointUrl: null,
    supportsImageInput: false,
    enabled: true,
    status: "error",
    configVersion: 1,
    credentialVersion: 1,
    hasCredential: true,
    assignedAgentCount: 0,
    latestVerified: null,
    lastCheckedAt: null,
    lastErrorCategory: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function seedMachines(names: Array<{ id: string; name: string }> = [{ id: MACHINE_ID, name: "Studio Mac" }]) {
  useMachineStore.setState({
    machines: names.map((machine) => ({
      id: machine.id,
      name: machine.name,
      description: null,
      status: "online" as const,
      statusVersion: 1,
      apiKeyPrefix: null,
      runtimes: ["builtin"],
      runtimeVersions: { builtin: "pi-1" },
      hostname: null,
      os: null,
      daemonVersion: "daemon-1",
    })),
  } as never);
}

function successView(reply: string | null): ProviderProbeCreatedView {
  return {
    probe: {
      probeId: asProviderProbeId("11111111-1111-4111-8111-111111111111"),
      probeRequestId: asProviderProbeRequestId("probe-request-0001"),
      connectionId: CONNECTION_ID,
      computerId: MACHINE_ID,
      runtime: "builtin",
      model: "deepseek/deepseek-v4-pro",
      probeKind: "canary",
      configVersion: 1,
      credentialVersion: 1,
      outcome: "success",
      category: null,
      latencyMs: 42,
      responseSha256: "a".repeat(64),
      responseBytes: 2,
      verifiedAt: "2026-09-15T00:00:00.000Z",
      closedAt: "2026-09-15T00:00:00.000Z",
      createdAt: "2026-09-15T00:00:00.000Z",
      expiresAt: "2026-09-15T00:01:00.000Z",
    },
    reply,
    replayed: false,
  };
}

test("verification modal never auto-closes and shows the bounded reply", async (t) => {
  seedMachines();
  const posts: unknown[] = [];
  t.mock.method(api, "post", async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: successView("OK reply") };
  });

  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal
        connection={connection()}
        onClose={() => assert.fail("the verification modal must never auto-close")}
      />
    </TestIntlProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-success");
  assert.ok(screen.getByTestId("provider-connection-verify-dialog"));
  assert.equal(screen.getByTestId("provider-connection-verify-reply").textContent, "OK reply");
  assert.ok(screen.getByText(/Verified on Studio Mac/));
  assert.ok(screen.getByText(/42 ms/));

  fireEvent.click(screen.getByRole("button", { name: /Verify again/ }));
  await waitFor(() => assert.equal(posts.length, 2, "verify again is an explicit second provider call"));
});

test("verification failure shows the next step and the modal stays open", async (t) => {
  seedMachines();
  t.mock.method(api, "post", async () => {
    throw new Error("boom");
  });
  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal
        connection={connection()}
        onClose={() => assert.fail("the verification modal must never auto-close")}
      />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-failure");
  assert.ok(screen.getByText(/Address the category above/));
  assert.ok(screen.getByTestId("provider-connection-verify-dialog"));
});

test("verified-on chip renders from catalog data without extra requests", () => {
  render(
    <TestIntlProvider>
      <VerifiedOnChip
        latestVerified={{
          computerId: MACHINE_ID,
          computerName: "Studio Mac",
          runtime: "builtin",
          model: "deepseek/deepseek-v4-pro",
          verifiedAt: "2026-09-15T02:00:00.000Z",
        }}
      />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByTestId("provider-connection-verified-on"));
  assert.ok(screen.getByText(/Verified on/));
  assert.ok(screen.getByText(/Studio Mac/));
});

test("the settings row keeps the server-side test and adds Computer verification beside it", () => {
  render(
    <TestIntlProvider>
      <ConnectionRow
        connection={connection({ status: "ready" })}
        providerOptions={[{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }]}
        canManage
        busy={false}
        onTest={() => undefined}
        onVerify={() => undefined}
        onRename={() => undefined}
        onRotate={() => undefined}
        onToggle={() => undefined}
        onDelete={() => undefined}
      />
    </TestIntlProvider>,
  );
  assert.ok(screen.getByRole("button", { name: "Test connection" }));
  const verifyBtn = screen.getByRole("button", { name: "Verify on Computer" });
  assert.ok(verifyBtn.querySelector("svg.lucide-send"));
});

test("the verify modal submits the chosen model", async (t) => {
  seedMachines();
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(api, "post", async (url: string, body: Record<string, unknown>) => {
    posts.push({ url, body });
    return { data: successView("OK") };
  });
  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal connection={connection()} onClose={() => undefined} />
    </TestIntlProvider>,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
  const customOption = await screen.findByRole("option", { name: "Custom" });
  fireEvent.pointerDown(customOption);
  fireEvent.click(customOption);
  const modelInput = await screen.findByPlaceholderText("Custom model ID");
  fireEvent.change(modelInput, { target: { value: "deepseek/deepseek-v4-pro" } });
  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-success");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.body.model, "deepseek/deepseek-v4-pro");
  assert.equal(posts[0]!.body.runtime, "builtin");
  assert.equal(typeof posts[0]!.body.requestDigest, "string");
});

test("verify modal allows selecting a different computer", async (t) => {
  seedMachines([
    { id: "machine-1", name: "First Mac" },
    { id: "machine-2", name: "Second Mac" },
  ]);
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(api, "post", async (url: string, body: Record<string, unknown>) => {
    posts.push({ url, body });
    return { data: successView("OK") };
  });
  render(
    <TestIntlProvider>
      <VerifyProviderConnectionModal connection={connection()} onClose={() => undefined} />
    </TestIntlProvider>,
  );
  const computerSelect = screen.getByRole("combobox", { name: "Computer" });
  assert.equal(computerSelect.tagName, "BUTTON");
  fireEvent.click(computerSelect);
  const secondMacOption = await screen.findByRole("option", { name: "Second Mac" });
  fireEvent.pointerDown(secondMacOption);
  fireEvent.click(secondMacOption);
  fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
  await screen.findByTestId("provider-connection-verify-success");
  assert.equal(posts[0]!.body.computerId, "machine-2");
});

test("the catalog read model renders verified chips with a single catalog request", async (t) => {
  seedMachines();
  let gets = 0;
  t.mock.method(api, "get", async (url: string) => {
    gets += 1;
    assert.equal(url, "/provider-connections");
    return {
      data: {
        connections: [
          connection({
            status: "ready",
            latestVerified: {
              computerId: MACHINE_ID,
              computerName: "Studio Mac",
              runtime: "builtin",
              model: "deepseek/deepseek-v4-pro",
              verifiedAt: "2026-09-15T02:00:00.000Z",
            },
          }),
          connection({
            id: "836b2dc6-dbe6-4733-b1ec-8b52daf25e28",
            name: "Second DeepSeek",
            status: "ready",
            latestVerified: null,
          }),
        ],
        providerOptions: [{ id: "deepseek", label: "DeepSeek", providerKind: "preset" }],
      },
    };
  });
  useServerStore.setState({
    current: { id: "server-shadow", name: "Shadow", slug: "shadow" },
  } as never);
  setServerFeatureFlagForTests("server-shadow", PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, true);
  const { default: ProviderConnectionsSettings } = await import("../src/components/settings/ProviderConnectionsSettings");
  render(
    <MemoryRouter>
      <TestIntlProvider>
        <ProviderConnectionsSettings />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  await screen.findByTestId("provider-connection-verified-on");
  assert.ok(screen.getByText(/Studio Mac/));
  assert.equal(gets, 1, "two connections must not fan out into per-row receipt reads");
});
