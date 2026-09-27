import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import MachineDetailPanel from "../src/components/machine/MachineDetailPanel";
import { useAgentStore } from "../src/store/agentStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { renderWithIntl } from "./helpers/intl";

const initialAgentState = useAgentStore.getState();
const initialMachineState = useMachineStore.getState();
const initialServerState = useServerStore.getState();

const server: Server = {
  id: "server-1",
  name: "Acme",
  avatarUrl: null,
  slug: "acme",
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-08-08T00:00:00.000Z",
};

const standaloneComputer: Machine = {
  id: "computer-cli",
  name: "CLI Computer",
  description: null,
  status: "online",
  statusVersion: 1,
  apiKeyPrefix: null,
  runtimes: [],
  hostname: "cli.local",
  os: "darwin arm64",
  daemonVersion: "1.0.0",
  isComputer: true,
  computerAttachedByCurrentUser: true,
  creator: null,
  computerVersion: "1.0.28",
  hostKind: "standalone",
  computerUpgradeAvailable: true,
  computerBroadcastPolicy: {
    eligibility: "eligible",
    targetVersion: "1.0.38",
    targetRole: "post_K",
    migrationClass: "seamless",
    policyRevision: "hands:alpha:release-38",
    reasonCode: "eligible",
  },
  lastHeartbeat: null,
  createdAt: "2026-08-08T00:00:00.000Z",
};

const desktopComputer: Machine = {
  ...standaloneComputer,
  id: "computer-desktop",
  name: "Desktop Computer",
  hostKind: "desktop_app",
  computerUpgradeAvailable: false,
  computerBroadcastPolicy: {
    eligibility: "no_broadcast",
    targetVersion: null,
    targetRole: null,
    migrationClass: null,
    policyRevision: null,
    reasonCode: "app_managed",
  },
};

function renderMachine(machine: Machine) {
  useServerStore.setState({ current: server, members: [] });
  useAgentStore.setState({ agents: [] });
  useMachineStore.setState({ computerOperationProgress: {} });

  return renderWithIntl(
    <MemoryRouter initialEntries={[`/s/acme/settings/computers/${machine.id}`]}>
      <MachineDetailPanel machine={machine} workspaceEmbedded />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useAgentStore.setState(initialAgentState, true);
  useMachineStore.setState(initialMachineState, true);
  useServerStore.setState(initialServerState, true);
});

test("desktop-app Computer shows 'updates with the desktop app' instead of an upgrade prompt", () => {
  renderMachine(desktopComputer);

  assert.ok(screen.getByTestId("computer-updates-with-desktop-app"));
  assert.equal(screen.queryByText("(update available)"), null);
  assert.equal(screen.queryByRole("button", { name: /^(Upgrade|Unavailable)/ }), null);
  assert.equal(screen.queryByTestId("computer-upgrade-fresh-install-path"), null);
  assert.ok(screen.getByRole("button", { name: /Restart/ }));
});

test("standalone Computer keeps its upgrade prompt", () => {
  renderMachine(standaloneComputer);

  assert.equal(screen.queryByTestId("computer-updates-with-desktop-app"), null);
  assert.ok(screen.getByText("(update available)"));
  assert.ok(screen.getByRole("button", { name: /Upgrade/ }));
});
