import assert from "node:assert/strict";
import test from "node:test";
import {
  getComputerAttentionStatus,
  getComputerRowDotStatus,
  isAppManagedComputer,
  shouldShowComputerUpgradeIndicator,
} from "../src/utils/computerUpgradeIndicator";

const appManagedPolicy = {
  eligibility: "no_broadcast" as const,
  targetVersion: null,
  targetRole: null,
  migrationClass: null,
  policyRevision: null,
  reasonCode: "app_managed",
};

test("desktop-app Computer is app-managed via server policy or hostKind", () => {
  assert.equal(isAppManagedComputer({ isComputer: true, computerBroadcastPolicy: appManagedPolicy }), true);
  assert.equal(isAppManagedComputer({ isComputer: true, hostKind: "desktop_app" }), true);
});

test("standalone Computers and raw daemons are not app-managed", () => {
  assert.equal(isAppManagedComputer({ isComputer: true, hostKind: "standalone" }), false);
  assert.equal(isAppManagedComputer({ isComputer: true }), false);
  assert.equal(isAppManagedComputer({
    isComputer: true,
    hostKind: "standalone",
    computerBroadcastPolicy: { ...appManagedPolicy, eligibility: "eligible" as never, reasonCode: "eligible" },
  }), false);
  assert.equal(isAppManagedComputer({ isComputer: false, hostKind: "desktop_app" }), false);
});

test("app-managed Computer shows no upgrade dot; standalone upgrade prompt is unchanged", () => {
  const appManaged = {
    id: "mac",
    status: "online",
    isComputer: true,
    hostKind: "desktop_app" as const,
    computerUpgradeAvailable: false,
    computerBroadcastPolicy: appManagedPolicy,
  };
  assert.equal(shouldShowComputerUpgradeIndicator(appManaged), false);
  assert.equal(getComputerAttentionStatus(appManaged), "none");
  assert.equal(getComputerRowDotStatus(appManaged), "online");

  const standalone = { id: "cli", status: "online", isComputer: true, hostKind: "standalone" as const, computerUpgradeAvailable: true };
  assert.equal(shouldShowComputerUpgradeIndicator(standalone), true);
  assert.equal(getComputerAttentionStatus(standalone), "upgrade");
  assert.equal(getComputerRowDotStatus(standalone), "upgrade");
});
