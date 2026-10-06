// Cursor SDK 修复-1: the web sign-in entry routes are OWNER-ONLY.
// `POST .../cursor-sdk/login` starts a sign-in that binds the machine to
// whoever completes the browser authorization, so any member (or agent) must
// be rejected with 403 — a member starting one on someone else's machine and
// authorizing with their own Cursor account would silently rebind it. Status
// is owner-only for the same reason (sanitized, but still machine-private).

import assert from "node:assert/strict";

import { createApiTest } from "../test/integration/apiTest.js";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { serverMembers, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { registerMachine } from "../services/machineService.js";
import argon2 from "argon2";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}: ${res.status}`);
  const data = (await res.json()) as { accessToken: string };
  return data.accessToken;
}

async function seedCursorSdkRouteScenario(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner@slock.test`, `${slug}-owner`);
  const member = await seedUser(`${slug}-member@slock.test`, `${slug}-member`);
  const server = await createServer(`Cursor ${slug}`, `cursor-${slug}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  const machine = await registerMachine(server.id, owner.id, `${slug}-computer`);
  return { owner, member, server, machine: machine.machine };
}

test("machine owner can start a Cursor sign-in and read the sanitized status", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const scenario = await seedCursorSdkRouteScenario(`own-${Date.now()}`);
  try {
    const token = await login(app.baseUrl, scenario.owner.email);
    const loginRes = await fetch(`${app.baseUrl}/api/servers/${scenario.server.id}/machines/${scenario.machine.id}/cursor-sdk/login`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": scenario.server.id },
    });
    assert.equal(loginRes.status, 200);
    const loginData = (await loginRes.json()) as { ok: boolean; loginUrl?: string };
    assert.equal(loginData.ok, true);
    assert.equal(new URL(loginData.loginUrl ?? "").hostname, "cursor.com");

    const statusRes = await fetch(`${app.baseUrl}/api/servers/${scenario.server.id}/machines/${scenario.machine.id}/cursor-sdk/status`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": scenario.server.id },
    });
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(statusData).sort(), ["source", "status"], "status returns ONLY status + source");
    assert.equal(statusData.status, "unbound");
  } finally {
    await app.close();
  }
});

test("a non-owner member is rejected with 403 on login and status", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const scenario = await seedCursorSdkRouteScenario(`mem-${Date.now()}`);
  try {
    const memberToken = await login(app.baseUrl, scenario.member.email);
    const base = `${app.baseUrl}/api/servers/${scenario.server.id}/machines/${scenario.machine.id}/cursor-sdk`;
    const loginRes = await fetch(`${base}/login`, { method: "POST", headers: { Authorization: `Bearer ${memberToken}`, "X-Server-Id": scenario.server.id } });
    assert.equal(loginRes.status, 403, "member must not start a sign-in on someone else's machine");
    const statusRes = await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${memberToken}`, "X-Server-Id": scenario.server.id } });
    assert.equal(statusRes.status, 403, "member must not read machine auth status");
  } finally {
    await app.close();
  }
});

test("a non-member is stopped by the server-membership gate before any machine lookup", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  const scenario = await seedCursorSdkRouteScenario(`out-${Date.now()}`);
  const outsider = await seedUser(`outside-${Date.now()}@slock.test`, "outside");
  try {
    const outsiderToken = await login(app.baseUrl, outsider.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${scenario.server.id}/machines/${scenario.machine.id}/cursor-sdk/login`, {
      method: "POST",
      headers: { Authorization: `Bearer ${outsiderToken}`, "X-Server-Id": scenario.server.id },
    });
    // requireServer rejects non-members before the handler's own 404s; either
    // way no machine information and no sign-in is reachable.
    assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
  } finally {
    await app.close();
  }
});
