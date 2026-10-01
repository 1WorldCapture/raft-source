import assert from "node:assert/strict";
import test from "node:test";
import {
  channelExcludedFromUnmutedUnread,
  isAnnouncementChannel,
  isSystemPostedAnnouncement,
} from "../src/utils/announcementChannel.js";

test("recognizes the announcement channel only by systemKind", () => {
  assert.equal(isAnnouncementChannel({ systemKind: "announcement" }), true);
  assert.equal(isAnnouncementChannel({ systemKind: "all" }), false);
  assert.equal(isAnnouncementChannel({ systemKind: null }), false);
  assert.equal(isAnnouncementChannel({}), false);
  assert.equal(isAnnouncementChannel(null), false);
});

test("default-muted announcement channels do not count toward unmuted unread", () => {
  const announcement = { systemKind: "announcement" as const };
  assert.equal(channelExcludedFromUnmutedUnread(announcement), true);
  assert.equal(channelExcludedFromUnmutedUnread({ ...announcement, activityMuted: true }), true);
  assert.equal(channelExcludedFromUnmutedUnread({ ...announcement, activityMuted: false }), false);
  assert.equal(channelExcludedFromUnmutedUnread({ systemKind: null, activityMuted: true }), true);
  assert.equal(channelExcludedFromUnmutedUnread({ systemKind: null }), false);
});

test("system-posted announcements use the announcement-proxy metadata kind", () => {
  assert.equal(isSystemPostedAnnouncement({ actionMetadata: { kind: "announcement-proxy" } }), true);
  assert.equal(isSystemPostedAnnouncement({ actionMetadata: { kind: "action-card" } }), false);
  assert.equal(isSystemPostedAnnouncement({ actionMetadata: null }), false);
  assert.equal(isSystemPostedAnnouncement({}), false);
});
