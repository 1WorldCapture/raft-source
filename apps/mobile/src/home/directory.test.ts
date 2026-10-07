import assert from "node:assert/strict";
import test from "node:test";
import { groupHasUnread, groupHomeChannels, pinnedChannelIds } from "./directory";
import type { RaftChannel } from "../model/messages";

function channel(partial: Partial<RaftChannel> & Pick<RaftChannel, "id" | "name">): RaftChannel {
  return { type: "channel", ...partial };
}

test("groupHomeChannels puts pinned rows first and keeps joint channels out of the channel list", () => {
  const groups = groupHomeChannels([
    channel({ id: "all", name: "all" }),
    channel({ id: "joint-1", name: "shared", type: "joint" }),
    channel({ id: "dm-1", name: "Ada", type: "dm" }),
    channel({ id: "old", name: "old", archivedAt: "2026-01-01" }),
    channel({ id: "thread-1", name: "thread", type: "thread" }),
  ], new Set(["all"]));
  assert.deepEqual(groups.pinned.map((item) => item.id), ["all"]);
  assert.deepEqual(groups.joint.map((item) => item.id), ["joint-1"]);
  assert.deepEqual(groups.channels, []);
  assert.deepEqual(groups.dms.map((item) => item.id), ["dm-1"]);
});

test("pinnedChannelIds reads channel ids and ignores agent pins", () => {
  const ids = pinnedChannelIds({
    pinnedChannelIds: ["all"],
    pinned: [{ type: "channel", channelId: "extra" }, { type: "agent", id: "agent-1" }],
  });
  assert.deepEqual([...ids], ["all", "extra"]);
});

test("groupHasUnread is true when a collapsed group still has a mention", () => {
  const channels = [channel({ id: "all", name: "all" })];
  assert.equal(groupHasUnread(channels, { all: { unreadCount: 0, hasMention: true } }, {}), true);
  assert.equal(groupHasUnread(channels, {}, {}), false);
});
