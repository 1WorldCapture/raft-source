import { tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * #unread-badges task #4: every operation that can change a user's unread
 * summary sends `unread_summary:changed { serverId }` to that user's room
 * (and only to affected users).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { UNREAD_SUMMARY_CHANGED_EVENT } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { serverMembers } from "../db/schema.js";
import { addHuman, createChannel, setInboxTargetActivityMuteState } from "../services/channelService.js";
import {
  __testUnreadSummaryNotifier,
  ACTIVITY_LEADING_DELAY_MS,
  setUnreadSummaryIO,
  USER_ACTION_DEBOUNCE_MS,
} from "../services/unreadSummaryNotifier.js";
import { createServer, headers, installFakeIo, seedUser } from "./channels.api.fixtures.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type Captured = { room: string; event: string; payload: unknown };
let captured: Captured[] = [];
setUnreadSummaryIO({
  to(room: string) {
    return { emit(event: string, payload: unknown) { captured.push({ room, event, payload }); } };
  },
});

afterEach(() => {
  __testUnreadSummaryNotifier.reset();
  captured = [];
});

const settle = (ms = USER_ACTION_DEBOUNCE_MS + 250) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rooms that received unread_summary:changed for this server since the last reset. */
function roomsNotified(serverId: string): string[] {
  return [...new Set(captured
    .filter((entry) => entry.event === UNREAD_SUMMARY_CHANGED_EVENT && (entry.payload as { serverId: string }).serverId === serverId)
    .map((entry) => entry.room))].sort();
}

function resetCapture() {
  __testUnreadSummaryNotifier.reset();
  captured = [];
}

test("unread_summary:changed reaches the affected user for messages, reads, Done/undone, membership, archive and mute", async ({ app }) => {
  const appEvents = installFakeIo(app.app);
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`us-owner-${suffix}@slock.test`, `us-owner-${suffix}`);
  const member = await seedUser(`us-member-${suffix}@slock.test`, `us-member-${suffix}`);
  const server = await createServer("Unread Summary", `unread-summary-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const channel = await createChannel(server.id, `us-room-${suffix}`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const ownerHeaders = { ...headers(ownerToken, server.id), "Content-Type": "application/json" };
  const memberHeaders = { ...headers(memberToken, server.id), "Content-Type": "application/json" };
  await settle();
  resetCapture();

  // New message: the other member is notified (Activity). The sender's own
  // cursor advance may also notify them, on the rate-limited cadence.
  const sent = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ channelId: channel.id, content: "hello" }),
  });
  assert.equal(sent.status, 200);
  const sentBody = await sent.json() as { seq?: number; message?: { seq: number } };
  const seq = Number(sentBody.message?.seq ?? sentBody.seq);
  await settle(ACTIVITY_LEADING_DELAY_MS + 250);
  assert.ok(roomsNotified(server.id).includes(`user:${member.id}`));

  // Read.
  resetCapture();
  const read = await fetch(`${app.baseUrl}/api/channels/${channel.id}/read`, {
    method: "POST", headers: memberHeaders, body: JSON.stringify({ seq }),
  });
  assert.equal(read.status, 200);
  await settle();
  assert.deepEqual(roomsNotified(server.id), [`user:${member.id}`]);

  // Done (also pushes read_state:updated for the moved cursor) and undone.
  await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST", headers: ownerHeaders, body: JSON.stringify({ channelId: channel.id, content: "more" }),
  });
  await settle(ACTIVITY_LEADING_DELAY_MS + 250);
  resetCapture();
  appEvents.length = 0;
  const done = await fetch(`${app.baseUrl}/api/channels/inbox/done`, {
    method: "POST", headers: memberHeaders, body: JSON.stringify({ channelId: channel.id }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  await settle();
  assert.deepEqual(roomsNotified(server.id), [`user:${member.id}`]);
  assert.ok(
    appEvents.some((event) => event.event === "read_state:updated" && event.room === `user:${member.id}`),
    "Done pushes read_state:updated like an ordinary read",
  );
  resetCapture();
  const undone = await fetch(`${app.baseUrl}/api/channels/inbox/undone`, {
    method: "POST", headers: memberHeaders, body: JSON.stringify({ channelId: channel.id }),
  });
  assert.equal(undone.status, 200);
  await settle();
  assert.deepEqual(roomsNotified(server.id), [`user:${member.id}`]);

  // Leave and re-add.
  resetCapture();
  const leave = await fetch(`${app.baseUrl}/api/channels/${channel.id}/leave`, { method: "POST", headers: memberHeaders });
  assert.equal(leave.status, 200, await leave.clone().text());
  await settle();
  assert.deepEqual(roomsNotified(server.id), [`user:${member.id}`]);
  resetCapture();
  await addHuman(channel.id, member.id);
  await settle();
  assert.deepEqual(roomsNotified(server.id), [`user:${member.id}`]);

  // Mute changes.
  resetCapture();
  await setInboxTargetActivityMuteState({
    receiverType: "user", receiverId: member.id, serverId: server.id, sourceChannelId: channel.id, activityMuted: true,
  });
  await settle();
  assert.deepEqual(roomsNotified(server.id), [`user:${member.id}`]);

  // Archive notifies every human in the channel.
  resetCapture();
  const archive = await fetch(`${app.baseUrl}/api/channels/${channel.id}/archive`, { method: "POST", headers: ownerHeaders });
  assert.equal(archive.status, 200, await archive.clone().text());
  await settle();
  assert.deepEqual(roomsNotified(server.id), [`user:${member.id}`, `user:${owner.id}`].sort());
});
