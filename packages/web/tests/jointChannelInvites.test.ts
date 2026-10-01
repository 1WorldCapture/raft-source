import assert from "node:assert/strict";
import test from "node:test";
import { jointInviteErrorText, parsePendingJointChannelInvites } from "../src/utils/jointChannelInvites.js";

const invite = {
  id: "inv-1",
  jointChannelId: "joint-1",
  fromServerName: "RaftBuild",
  fromServerSlug: "raftbuild",
  channelName: "IT",
  channelDescription: null,
  invitedByUserId: "user-1",
  expiresAt: "2026-10-02T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
};

test("parses pending joint invites and drops malformed rows", () => {
  assert.deepEqual(parsePendingJointChannelInvites({ invites: [invite, { id: 1 }, null] }), [invite]);
  assert.deepEqual(parsePendingJointChannelInvites(null), []);
  assert.deepEqual(parsePendingJointChannelInvites({ invites: "nope" }), []);
});

test("prefers the server error text when an accept fails", () => {
  assert.equal(jointInviteErrorText({ response: { data: { error: "Invite expired" } } }, "fallback"), "Invite expired");
  assert.equal(jointInviteErrorText({ response: { data: {} } }, "fallback"), "fallback");
  assert.equal(jointInviteErrorText(null, "fallback"), "fallback");
});
