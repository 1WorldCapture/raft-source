import assert from "node:assert/strict";
import test from "node:test";
import { channelUnread } from "./unread.ts";

test("channelUnread fails closed only when the server says the cursor is absent", () => {
  assert.deepEqual(channelUnread(null), { unread: false, count: null });
  assert.deepEqual(channelUnread({ kind: "absent" }), { unread: true, count: null });
});

test("channelUnread counts a small seq gap and hides a caught-up channel", () => {
  assert.deepEqual(
    channelUnread({ kind: "present", maxReadSeq: "10", latestActivity: { seq: "12" } }),
    { unread: true, count: 2 },
  );
  assert.deepEqual(
    channelUnread({ kind: "present", maxReadSeq: "12", latestActivity: { seq: "12" } }),
    { unread: false, count: 0 },
  );
});

test("channelUnread keeps a badge without a count when seqs are outside safe integers", () => {
  const latest = "9007199254740993";
  const read = "9007199254740991";
  assert.deepEqual(
    channelUnread({ kind: "present", maxReadSeq: read, latestActivity: { seq: latest } }),
    { unread: true, count: null },
  );
});
