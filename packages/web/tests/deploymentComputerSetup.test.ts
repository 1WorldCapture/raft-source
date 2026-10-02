import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchDeploymentComputerSetup,
  validateDeploymentComputerSetupResponse,
} from "../src/utils/deploymentComputerSetup";
import api from "../src/api/client";

const READY_MANIFEST = {
  schemaVersion: 1,
  status: "ready",
  serverUrl: "https://raft.example.private",
  releaseSource: {
    backend: "manifest",
    releaseBase: "https://raft.example.private/computer",
  },
  installChannel: "latest",
};

const READY_HANDS = {
  schemaVersion: 1,
  status: "ready",
  serverUrl: "https://raft.example.private",
  releaseSource: {
    backend: "hands",
    releaseBase: "https://raft.example.private/computer",
    handsOrigin: "https://hands.example.private",
  },
  installChannel: "pinned:1.2.3",
};

const READY_HANDS_ALPHA = {
  ...READY_HANDS,
  installChannel: "alpha",
};

test("validate accepts a manifest-backend ready payload", () => {
  const validated = validateDeploymentComputerSetupResponse(READY_MANIFEST);
  assert.ok(validated);
  assert.equal(validated.status, "ready");
  assert.deepEqual(
    validated.status === "ready" ? validated.releaseSource : null,
    { backend: "manifest", releaseBase: "https://raft.example.private/computer" },
  );
});

test("validate accepts a hands-backend payload and requires handsOrigin", () => {
  const validated = validateDeploymentComputerSetupResponse(READY_HANDS);
  assert.ok(validated);
  assert.equal(validated.status, "ready");
  if (validated.status === "ready") {
    assert.equal(validated.releaseSource.handsOrigin, "https://hands.example.private");
    assert.equal(validated.installChannel, "pinned:1.2.3");
  }

  const missingHandsOrigin = validateDeploymentComputerSetupResponse({
    ...READY_HANDS,
    releaseSource: { backend: "hands", releaseBase: READY_HANDS.releaseSource.releaseBase },
  });
  assert.equal(missingHandsOrigin, null);
});

test("validate passes through declared missing/invalid states with their fields", () => {
  for (const status of ["missing", "invalid"] as const) {
    const validated = validateDeploymentComputerSetupResponse({
      schemaVersion: 1,
      status,
      fields: ["RAFT_PUBLIC_ORIGIN"],
    });
    assert.ok(validated);
    assert.equal(validated.status, status);
    assert.deepEqual(validated.status === "ready" ? [] : validated.fields, ["RAFT_PUBLIC_ORIGIN"]);
  }
});

test("hands+alpha ready payloads are accepted; manifest+alpha is an explicit invalid config", () => {
  const validated = validateDeploymentComputerSetupResponse(READY_HANDS_ALPHA);
  assert.ok(validated);
  assert.equal(validated.status, "ready");
  if (validated.status === "ready") {
    assert.equal(validated.installChannel, "alpha");
  }

  const manifestAlpha = validateDeploymentComputerSetupResponse({ ...READY_MANIFEST, installChannel: "alpha" });
  assert.ok(manifestAlpha);
  assert.equal(manifestAlpha.status, "invalid");
  assert.deepEqual(manifestAlpha.status === "ready" ? [] : manifestAlpha.fields, [
    "RAFT_COMPUTER_RELEASE_BACKEND",
    "installChannel",
  ]);
});

test("validate rejects unknown schema versions and malformed ready payloads", () => {
  assert.equal(validateDeploymentComputerSetupResponse(null), null);
  assert.equal(validateDeploymentComputerSetupResponse("nope"), null);
  assert.equal(validateDeploymentComputerSetupResponse({ schemaVersion: 2, status: "ready" }), null);
  assert.equal(validateDeploymentComputerSetupResponse({ ...READY_MANIFEST, serverUrl: "" }), null);
  assert.equal(validateDeploymentComputerSetupResponse({ ...READY_MANIFEST, installChannel: "pinned:notasemver" }), null);
  assert.equal(validateDeploymentComputerSetupResponse({ ...READY_HANDS_ALPHA, installChannel: "beta" }), null);
  assert.equal(
    validateDeploymentComputerSetupResponse({ ...READY_MANIFEST, releaseSource: { backend: "ftp", releaseBase: "x" } }),
    null,
  );
});

test("fetch maps every failure mode to an explicit unavailable reason", async () => {
  const originalGet = api.get;
  const calls: Array<[string, unknown]> = [];
  try {
    api.get = (async (url: string, config?: unknown) => {
      calls.push([url, config]);
      return { data: READY_MANIFEST };
    }) as typeof api.get;
    assert.deepEqual(await fetchDeploymentComputerSetup(), {
      kind: "ready",
      config: validateDeploymentComputerSetupResponse(READY_MANIFEST),
    });

    api.get = (async () => ({ data: { schemaVersion: 1, status: "missing", fields: ["RAFT_PUBLIC_ORIGIN"] } })) as typeof api.get;
    assert.deepEqual(await fetchDeploymentComputerSetup(), {
      kind: "unavailable",
      reason: "missing",
      fields: ["RAFT_PUBLIC_ORIGIN"],
    });

    api.get = (async () => ({ data: { schemaVersion: 9, status: "ready" } })) as typeof api.get;
    assert.deepEqual(await fetchDeploymentComputerSetup(), {
      kind: "unavailable",
      reason: "unsupported-schema",
      fields: [],
    });

    api.get = (async () => {
      throw new Error("offline");
    }) as typeof api.get;
    assert.deepEqual(await fetchDeploymentComputerSetup(), {
      kind: "unavailable",
      reason: "network",
      fields: [],
    });
  } finally {
    api.get = originalGet;
  }
  assert.equal(calls[0]?.[0], "/api/deployment/computer-setup");
});
