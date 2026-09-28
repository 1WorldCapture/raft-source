import assert from "node:assert/strict";
import test from "node:test";

import {
  chatAttentionUnreadTotal,
  hasChatAttentionUnread,
  selectChatAttentionChannelIds,
} from "../src/utils/chatAttentionUnread";

test("Chat attention includes joined public channels, private channels, and DMs", () => {
  const ids = selectChatAttentionChannelIds(
    [
      { id: "joined-public", type: "channel", joined: true },
      { id: "private", type: "private" },
    ],
    [{ id: "dm" }],
  );

  assert.deepEqual(ids, ["joined-public", "private", "dm"]);
  assert.equal(hasChatAttentionUnread(ids, { private: 2 }), true);
  assert.equal(hasChatAttentionUnread(ids, { dm: 1 }), true);
});

test("unjoined public unread remains row-level state without lighting Chat", () => {
  const unreadCounts = { "public-discovery": 3 };
  const ids = selectChatAttentionChannelIds(
    [{ id: "public-discovery", type: "channel", joined: false }],
    [],
  );

  assert.deepEqual(ids, []);
  assert.equal(hasChatAttentionUnread(ids, unreadCounts), false);
  assert.equal(unreadCounts["public-discovery"], 3);
});

test("an unjoined public unread cannot mask eligible Chat attention", () => {
  const ids = selectChatAttentionChannelIds(
    [
      { id: "public-discovery", type: "channel", joined: false },
      { id: "joined-public", type: "channel", joined: true },
    ],
    [],
  );

  assert.equal(hasChatAttentionUnread(ids, {
    "public-discovery": 4,
    "joined-public": 1,
  }), true);
});

test("chatAttentionUnreadTotal sums only attention channels (dock badge caliber)", () => {
  const ids = selectChatAttentionChannelIds(
    [
      { id: "joined-public", type: "channel", joined: true },
      { id: "public-discovery", type: "channel", joined: false },
      { id: "private-invite", type: "private" },
    ],
    [{ id: "dm-1" }, { id: "dm-2" }],
  );

  // Unjoined discovery unread and unknown/thread channels never count.
  assert.equal(chatAttentionUnreadTotal(ids, {
    "joined-public": 2,
    "public-discovery": 99,
    "private-invite": 3,
    "dm-1": 5,
    "dm-2": 1,
    "thread-xyz": 7,
  }), 11);
  assert.equal(chatAttentionUnreadTotal(ids, {}), 0);
  assert.equal(chatAttentionUnreadTotal(ids, { "joined-public": 0, "dm-1": 0 }), 0);
  assert.equal(chatAttentionUnreadTotal([], { anything: 4 }), 0);
  assert.equal(chatAttentionUnreadTotal(ids, { "joined-public": -3 }), 0, "negative garbage never dips below zero");
});
