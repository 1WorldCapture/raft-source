import assert from "node:assert/strict";
import test from "node:test";
import { collectSenderAvatars } from "./senderAvatars.ts";

test("collectSenderAvatars maps agent ids and member user ids, skipping deleted agents", () => {
  const map = collectSenderAvatars(
    { agents: [{ id: "a1", avatarUrl: "pixel:robot" }, { id: "a2", avatarUrl: "pixel:cat", deletedAt: "2026-01-01" }, { id: "a3" }] },
    [{ userId: "u1", avatarUrl: "https://example.com/u1.png" }, { userId: "u2", avatarUrl: "" }],
  );
  assert.deepEqual(map, { a1: "pixel:robot", u1: "https://example.com/u1.png" });
});

test("collectSenderAvatars tolerates missing or malformed responses", () => {
  assert.deepEqual(collectSenderAvatars(null, { members: "nope" }), {});
});
