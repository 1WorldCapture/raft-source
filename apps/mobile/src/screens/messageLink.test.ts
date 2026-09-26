import assert from "node:assert/strict";
import test from "node:test";
import { messagePermalink } from "./messageLink";

test("message permalink matches the web channel and thread shape", () => {
  assert.equal(
    messagePermalink("http://raft.example.com", "raft", "channel-1", "message-1"),
    "http://raft.example.com/s/raft/channel/channel-1?msg=message-1",
  );
  assert.equal(
    messagePermalink("http://raft.example.com/", "raft", "thread-1", "reply-1", { threadParentMessageId: "parent-1" }),
    "http://raft.example.com/s/raft/channel/thread-1?msg=reply-1&thread=thread-1%3Aparent-1",
  );
  assert.equal(
    messagePermalink("http://raft.example.com", "raft", "dm-1", "message-1", { dm: true }),
    "http://raft.example.com/s/raft/dm/dm-1?msg=message-1",
  );
});
