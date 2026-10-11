import assert from "node:assert/strict";
import test from "node:test";
import { runtimeModelsRequestPath } from "../src/hooks/useRuntimeModels.js";

const identity = { serverId: "srv-1", machineId: "mac-1", runtime: "claude" };

test("an identity-driven load stays on the daemon-cached path", () => {
  assert.equal(
    runtimeModelsRequestPath({ ...identity, rescan: false }),
    "/servers/srv-1/machines/mac-1/runtime-models/claude",
  );
});

test("a rescan click bypasses the daemon's detection cache with ?refresh=1", () => {
  assert.equal(
    runtimeModelsRequestPath({ ...identity, rescan: true }),
    "/servers/srv-1/machines/mac-1/runtime-models/claude?refresh=1",
  );
});
