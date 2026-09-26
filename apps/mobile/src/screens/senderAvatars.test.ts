import assert from "node:assert/strict";
import test from "node:test";
import { collectSenderAvatars, collectSenderNames } from "./senderAvatars.ts";

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

test("collectSenderNames prefers displayName and skips deleted rows", () => {
  const map = collectSenderNames(
    { agents: [{ id: "a1", name: "bot", displayName: "Builder" }, { id: "a2", name: "gone", deletedAt: "2026-01-01" }] },
    [{ userId: "u1", name: "ada", displayName: "Ada" }, { userId: "u2", name: "  " }],
  );
  assert.deepEqual(map, { a1: "Builder", u1: "Ada" });
});
