import assert from "node:assert/strict";
import test from "node:test";
import {
  channelExcludedFromUnmutedUnread,
  isAnnouncementChannel,
  isSystemPostedAnnouncement,
} from "../src/utils/announcementChannel.js";

test("recognizes the announcement channel by systemKind, then by reserved name", () => {
  assert.equal(isAnnouncementChannel({ systemKind: "announcement", name: "announcements", type: "channel" }), true);
  assert.equal(isAnnouncementChannel({ name: "announcement", type: "channel" }), true);
  assert.equal(isAnnouncementChannel({ systemKind: "all", name: "announcement", type: "channel" }), false);
  assert.equal(isAnnouncementChannel({ name: "announcement", type: "private" }), false);
  assert.equal(isAnnouncementChannel({ name: "all", type: "channel" }), false);
  assert.equal(isAnnouncementChannel(null), false);
});

test("default-muted announcement channels do not count toward unmuted unread", () => {
  const announcement = { name: "announcement", type: "channel" as const };
  assert.equal(channelExcludedFromUnmutedUnread(announcement), true);
  assert.equal(channelExcludedFromUnmutedUnread({ ...announcement, activityMuted: true }), true);
  assert.equal(channelExcludedFromUnmutedUnread({ ...announcement, activityMuted: false }), false);
  assert.equal(channelExcludedFromUnmutedUnread({ name: "general", type: "channel", activityMuted: true }), true);
  assert.equal(channelExcludedFromUnmutedUnread({ name: "general", type: "channel" }), false);
});

test("system-posted announcements are only the explicit flag", () => {
  assert.equal(isSystemPostedAnnouncement({ postedBySystem: true }), true);
  assert.equal(isSystemPostedAnnouncement({ postedBySystem: false }), false);
  assert.equal(isSystemPostedAnnouncement({}), false);
});
