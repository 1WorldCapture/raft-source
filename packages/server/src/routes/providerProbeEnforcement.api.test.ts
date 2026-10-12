import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import { getDb } from "../db/index.js";
import {
  agentProviderConnections,
  agents,
  featureFlagRules,
  machines,
  providerConnections,
  serverMembers,
  users,
} from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { resolveProviderConnectionLaunch, __setProviderConnectionFetchFactoryForTests } from "../services/providerConnectionService.js";
import {
  __setProviderProbeCarrierForTests,
  type ProbeCarrier,
  type ProbeCarrierFact,
} from "../services/providerProbeService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const AUTHORITY = { connectionEpochId: "epoch-enf", replicaGeneration: "gen-enf" };
const FACT: ProbeCarrierFact = {
  capabilities: ["provider-probe:v1"],
  connectionEpochId: AUTHORITY.connectionEpochId,
  replicaGeneration: AUTHORITY.replicaGeneration,
  daemonVersion: "daemon-1",
  computerVersion: "computer-1",
  runtimes: ["builtin"],
  runtimeVersions: { builtin: "pi-1" },
};
const MODEL = "deepseek/deepseek-v4-pro";

test("connections flag enables Computer probes without retiring server-side test", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 15).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  let providerCalls = 0;
  try {
    const owner = await seedUser("enf-owner@raft.test", "enf-owner");
    const server = await createServer("Enforcement", `enf-${randomUUID().slice(0, 6)}`, owner.id);
    const ownerToken = await login(app.baseUrl, owner.email);
    for (const flagKey of [PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY]) {
      await getDb().insert(featureFlagRules).values({
        id: randomUUID(), flagKey, stage: "server", priority: -100, decision: "allow", values: [server.id],
      });
    }
    const createdConnection = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Enf DeepSeek", providerId: "deepseek", apiKey: "enf-secret" }),
    });
    assert.equal(createdConnection.status, 201);
    const connection = (await createdConnection.json()) as { id: string };
    await getDb().update(providerConnections).set({ status: "ready" }).where(eq(providerConnections.id, connection.id));
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id, userId: owner.id, name: "enf-machine", apiKeyHash: "he", runtimes: ["builtin"],
    }).returning();
    const [agent] = await getDb().insert(agents).values({
      serverId: server.id,
      name: "enf-agent",
      machineId: machine.id,
      runtime: "builtin",
      runtimeConfig: {
        version: 1,
        runtime: "builtin",
        provider: { kind: "connection", connectionId: connection.id },
        model: { kind: "preset", id: MODEL },
        mode: { kind: "default" },
        hostUserState: "forbidden",
      },
    }).returning();
    await getDb().insert(agentProviderConnections).values({
      serverId: server.id,
      agentId: agent.id,
      connectionId: connection.id,
      expectedConfigVersion: 1,
      expectedCredentialVersion: 1,
      updatedByUserId: owner.id,
    });

    // Launch does not require probe verification — enabled connection materializes directly.
    const launchedBeforeProbe = await resolveProviderConnectionLaunch({
      serverId: server.id,
      agentId: agent.id,
      connectionId: connection.id,
    });
    assert.ok(launchedBeforeProbe.envVars);

    const carrier: ProbeCarrier = {
      readFact: async () => FACT,
      dispatch: async (_machineId, command) => {
        await import("../services/providerProbeService.js").then((mod) => mod.materializeProviderProbe({
          serverId: server.id,
          probeId: command.probeId,
          machineId: machine.id,
          claimRequestId: command.requestId,
          fact: FACT,
        }));
        const reply = "OK";
        const { sha256Hex, utf8ByteLength, providerProbeResultDigest, providerProbeAuthorityIdentity } = await import("@botiverse/raft-shared");
        const responseSha256 = await sha256Hex(reply);
        const responseBytes = utf8ByteLength(reply);
        return {
          kind: "result" as const,
          result: {
            type: "machine:provider_probe:result" as const,
            requestId: command.requestId,
            probeId: command.probeId,
            outcome: "success" as const,
            category: null,
            latencyMs: 5,
            responseSha256,
            responseBytes,
            resultDigest: await providerProbeResultDigest({
              outcome: "success", category: null, responseSha256, responseBytes,
              authorityIdentity: await providerProbeAuthorityIdentity(AUTHORITY),
            }),
            authorityEcho: AUTHORITY,
            daemonVersion: "daemon-1",
            computerVersion: "computer-1",
            runtimeVersion: "pi-1",
            reply,
          },
        };
      },
    };
    __setProviderProbeCarrierForTests(carrier);
    const verify = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/probes`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify(await createProbeBody(connection.id, machine.id, MODEL)),
    });
    assert.equal(verify.status, 201);

    const launched = await resolveProviderConnectionLaunch({ serverId: server.id, agentId: agent.id, connectionId: connection.id });
    assert.ok(launched.envVars);

    // The catalog carries the verified coordinates in one batched read.
    const catalog = await fetch(`${app.baseUrl}/api/provider-connections`, { headers: headers(ownerToken, server.id) });
    assert.equal(catalog.status, 200);
    const catalogBody = (await catalog.json()) as { connections: Array<{ id: string; latestVerified: { computerName: string | null; model: string } | null }> };
    const row = catalogBody.connections.find((entry) => entry.id === connection.id);
    assert.equal(row?.latestVerified?.computerName, "enf-machine");
    assert.equal(row?.latestVerified?.model, MODEL);

    // Server-side /test and model catalog stay beside the probe. A stubbed
    // provider response proves those routes still perform I/O. This runs after
    // launch checks because a failed test marks the connection status error.
    __setProviderConnectionFetchFactoryForTests(() => {
      providerCalls += 1;
      return {
        fetch: async () => new Response(JSON.stringify({ error: "stub" }), { status: 401, headers: { "content-type": "application/json" } }),
        close: async () => {},
      };
    });
    const serverTest = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/test`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ model: MODEL, message: "hi" }),
    });
    assert.notEqual(serverTest.status, 410);
    assert.equal(serverTest.status, 502);
    const serverModels = await fetch(`${app.baseUrl}/api/provider-connections/${connection.id}/models`, {
      headers: headers(ownerToken, server.id),
    });
    assert.notEqual(serverModels.status, 410);
    assert.equal(serverModels.status, 502);
    assert.equal(providerCalls, 2, "server-side test and model catalog still call the provider");
  } finally {
    __setProviderProbeCarrierForTests(null);
    __setProviderConnectionFetchFactoryForTests(null);
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email, name, displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

async function createProbeBody(connectionId: string, computerId: string, model: string) {
  const { providerProbeRequestDigest } = await import("@botiverse/raft-shared");
  const payload = { computerId, runtime: "builtin", model, probeKind: "canary" as const };
  return {
    probeRequestId: `probe-req-${randomUUID()}`,
    requestDigest: await providerProbeRequestDigest({ connectionId, ...payload }),
    ...payload,
  };
}

test("probe and enforcement predicates read the single provider_connections_v0 key", async () => {
  const { isProviderProbesEnabled, isProviderProbeEnforcementEnabled } = await import("../services/providerConnectionFeature.js");
  const { getDb: db } = await import("../db/index.js");
  const { createServer: makeServer } = await import("../services/serverService.js");
  const { featureFlagRules: rules, users: usersTable } = await import("../db/schema.js");
  const { eq: eqOp } = await import("drizzle-orm");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const [owner] = await db().insert(usersTable).values({
      email: "single-key@raft.test", name: "single-key", displayName: "single-key",
      passwordHash: await fixturePasswordHash("password123"), emailVerified: true, profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await makeServer("Single Key", `single-key-${randomUUID().slice(0, 6)}`, owner.id);
    assert.equal(await isProviderProbesEnabled(server.id), false);
    assert.equal(await isProviderProbeEnforcementEnabled(server.id), false);
    await db().insert(rules).values({
      id: randomUUID(), flagKey: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, stage: "server", priority: -100, decision: "allow", values: [server.id],
    });
    assert.equal(await isProviderProbesEnabled(server.id), true, "probe capability follows the single switch");
    assert.equal(await isProviderProbeEnforcementEnabled(server.id), true, "enforcement follows the single switch");
    await db().delete(rules).where(eqOp(rules.flagKey, PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY));
    assert.equal(await isProviderProbesEnabled(server.id), false);
    assert.equal(await isProviderProbeEnforcementEnabled(server.id), false);
  } finally {
    await app.close();
  }
});
