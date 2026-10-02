import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

import {
  RAFT_COMPUTER_HANDS_ORIGIN_ENV,
  RAFT_COMPUTER_INSTALL_CHANNEL_ENV,
  RAFT_COMPUTER_PINNED_VERSION_ENV,
  RAFT_COMPUTER_RELEASE_BACKEND_ENV,
  RAFT_COMPUTER_RELEASE_BASE_ENV,
  RAFT_PUBLIC_ORIGIN_ENV,
} from "../config/computerDeploymentConfig.js";

const DEPLOYMENT_ENV_KEYS = [
  RAFT_PUBLIC_ORIGIN_ENV,
  RAFT_COMPUTER_RELEASE_BASE_ENV,
  RAFT_COMPUTER_RELEASE_BACKEND_ENV,
  RAFT_COMPUTER_HANDS_ORIGIN_ENV,
  RAFT_COMPUTER_PINNED_VERSION_ENV,
  RAFT_COMPUTER_INSTALL_CHANNEL_ENV,
] as const;

/**
 * Set exactly the provided deployment vars around one anonymous request.
 * The route is unauthenticated by design (the onboarding machine has no
 * session), so a plain fetch against the app is the honest client shape.
 */
async function getComputerSetup(
  baseUrl: string,
  vars: Record<string, string>,
): Promise<Response> {
  const saved: Record<string, string | undefined> = {};
  for (const key of DEPLOYMENT_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    return await fetch(`${baseUrl}/api/deployment/computer-setup`);
  } finally {
    for (const key of DEPLOYMENT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("GET /api/deployment/computer-setup: ready manifest payload, never cached", async ({ app }) => {
  const res = await getComputerSetup(app.baseUrl, {
    [RAFT_PUBLIC_ORIGIN_ENV]: "https://raft.example.com",
    [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://raft.example.com/computer",
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "manifest",
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), {
    schemaVersion: 1,
    status: "ready",
    serverUrl: "https://raft.example.com",
    releaseSource: {
      backend: "manifest",
      releaseBase: "https://raft.example.com/computer",
    },
    installChannel: "latest",
  });
});

test("GET /api/deployment/computer-setup: hands payload carries handsOrigin and pin channel", async ({ app }) => {
  const res = await getComputerSetup(app.baseUrl, {
    [RAFT_PUBLIC_ORIGIN_ENV]: "https://raft.example.com",
    [RAFT_COMPUTER_RELEASE_BASE_ENV]: "https://raft.example.com/computer",
    [RAFT_COMPUTER_RELEASE_BACKEND_ENV]: "hands",
    [RAFT_COMPUTER_HANDS_ORIGIN_ENV]: "https://hands.internal",
    [RAFT_COMPUTER_PINNED_VERSION_ENV]: "1.0.25",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    schemaVersion: 1,
    status: "ready",
    serverUrl: "https://raft.example.com",
    releaseSource: {
      backend: "hands",
      releaseBase: "https://raft.example.com/computer",
      handsOrigin: "https://hands.internal",
    },
    installChannel: "pinned:1.0.25",
  });
});

test("GET /api/deployment/computer-setup: unconfigured deployment reports missing field names only", async ({ app }) => {
  const res = await getComputerSetup(app.baseUrl, {});

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.status, "missing");
  assert.ok(Array.isArray(body.fields));
  assert.ok(body.fields.includes(RAFT_PUBLIC_ORIGIN_ENV));
  assert.ok(!("serverUrl" in body), "no half-built serverUrl on a not-ready payload");
  assert.ok(!("releaseSource" in body), "no half-built releaseSource on a not-ready payload");
});

test("GET /api/deployment/computer-setup: malformed values report invalid without echoing them", async ({ app }) => {
  const res = await getComputerSetup(app.baseUrl, {
    [RAFT_PUBLIC_ORIGIN_ENV]: "https://user:pass@raft.example.com",
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "invalid");
  assert.deepEqual(body.fields, [RAFT_PUBLIC_ORIGIN_ENV]);
  assert.ok(!JSON.stringify(body).includes("user:pass"));
});
