import assert from "node:assert/strict";
import test from "node:test";
import { deriveControls, routeUpdateAction } from "./thisComputerLogic.js";

const NOW = Date.parse("2026-09-27T10:00:00Z");
const input = { service: { running: true }, upgrade: null, latestVersion: "1.0.38", serverVersion: "1.0.28" };

test("app-embedded Computer: a newer CDN release is not an update", () => {
  const controls = deriveControls({ ...input, managementModel: "app" }, NOW);
  assert.equal(controls.updateAvailable, false);
  assert.equal(
    routeUpdateAction({ managementModel: "app", eligibility: "eligible", updateAvailable: controls.updateAvailable }),
    "none",
  );
});

test("standalone and unknown Computers still see the newer release", () => {
  for (const managementModel of ["standalone", "unknown", undefined] as const) {
    assert.equal(deriveControls({ ...input, managementModel }, NOW).updateAvailable, true, String(managementModel));
  }
  assert.equal(routeUpdateAction({ managementModel: "standalone", eligibility: "eligible", updateAvailable: true }), "remote");
});
