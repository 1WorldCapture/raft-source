import { createApiTest } from "../test/integration/apiTest.js";
/**
 * B1 follow-up (PM review of #348): `getOrCreateThread` must not create two
 * threads for one parent when two creators race. There is no unique index on
 * parent_message_id, so the outer canonical-thread check is not enough — the
 * winner of the root-message row lock must re-query inside the transaction.
 */
import assert from "node:assert/strict";
import argon2 from "argon2";

import { getDb } from "../db/index.js";
import { users, channels, messages } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createServer } from "../services/serverService.js";
import { createChannel, addHuman, getOrCreateThread } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedThreadFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "thread-race-owner@slock.test",
    name: "thread-race-owner",
    displayName: "Thread Race Owner",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Thread Race Server", "thread-race-test", owner.id);
  const channel = await createChannel(server.id, "thread-race-room");
  await addHuman(channel.id, owner.id);
  const parent = await createMessage(channel.id, "user", owner.id, "parent for racing thread creators");
  return { owner, server, channel, parent };
}

test("concurrent getOrCreateThread creators converge on one thread and one thread_id stamp", async ({ db }) => {
  void db;
  const { owner, parent } = await seedThreadFixture();

  const [first, second] = await Promise.all([
    getOrCreateThread(parent.id, owner.id, "user"),
    getOrCreateThread(parent.id, owner.id, "user"),
  ]);

  assert.equal(first.id, second.id, "both creators must converge on the same thread channel");
  assert.notEqual(first.created, second.created, "exactly one creator may report created=true");

  const rows = await getDb().select({ id: channels.id })
    .from(channels)
    .where(eq(channels.parentMessageId, parent.id));
  assert.equal(rows.length, 1, "only one thread channel may exist for the parent");

  const [parentRow] = await getDb().select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, parent.id));
  assert.equal(parentRow?.threadId, first.id, "the parent carries the converged thread_id stamp");

  // A later sequential call reuses the same thread and does not re-stamp.
  const third = await getOrCreateThread(parent.id, owner.id, "user");
  assert.equal(third.id, first.id);
  assert.equal(third.created, false);
});
