import { createApiTest } from "../test/integration/apiTest.js";
/**
 * Upstream 1.21.2 security port: authority-bearing writes re-lock the
 * actor's own `server_members` row inside the write transaction and
 * re-evaluate the authorization predicate under the locked role.
 *
 * Covered here at the fence layer (the route-level anti-enumeration
 * behavior lives in routes/agentCredentials.api.test.ts):
 *
 *   1. A current member's write runs and receives the role read under the
 *      row lock.
 *   2. A membership that is gone before the fence opens throws
 *      ServerMembershipRevokedError — the route maps that to the same
 *      `agent_missing` 404 as the request-level guard, so the two
 *      departure timings are byte-identical.
 */

import assert from "node:assert/strict";
import argon2 from "argon2";

import { getDb } from "../db/index.js";
import { users, serverMembers } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createServer } from "../services/serverService.js";
import {
  ServerMembershipRevokedError,
  withActorMembershipFence,
} from "./actorMembershipFence.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedMember(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`${name} fence server`, `${name}-fence`, user.id);
  return { user, server };
}

test("withActorMembershipFence runs the write and hands back the locked role", async ({ db }) => {
  void db; // fixture initializes the database before the fence runs
  const { user, server } = await seedMember("fence-member@slock.test", "fence-member");
  const seen = await withActorMembershipFence(server.id, user.id, async (_tx, role) => {
    return { role, wrote: true };
  });
  assert.deepEqual(seen, { role: "owner", wrote: true });
});

test("withActorMembershipFence throws ServerMembershipRevokedError once the membership row is gone", async ({ db }) => {
  void db; // fixture initializes the database before the fence runs
  const { user, server } = await seedMember("fence-departed@slock.test", "fence-departed");
  await getDb().delete(serverMembers)
    .where(eq(serverMembers.serverId, server.id));
  await assert.rejects(
    withActorMembershipFence(server.id, user.id, async () => {
      throw new Error("the fenced write must never run for a departed member");
    }),
    (error: unknown) => {
      assert.ok(error instanceof ServerMembershipRevokedError, `expected ServerMembershipRevokedError, got ${error}`);
      assert.equal(error.code, "server_membership_revoked");
      return true;
    },
  );
});
