import assert from "node:assert/strict";
import test from "node:test";
import type { RaftServer } from "../model/messages.ts";
import { useServerRailStore, type ServerRailClient } from "./serverRailStore.ts";
import { clampDragDelta, moveServerIds, nearestSlotIndex } from "./serverDrag.ts";

const slots = [
  { y: 0, height: 52 },
  { y: 52, height: 52 },
  { y: 104, height: 52 },
];

test("nearestSlotIndex picks the slot whose center is closest to the finger", () => {
  assert.equal(nearestSlotIndex(slots, 26), 0);
  assert.equal(nearestSlotIndex(slots, 78), 1);
  assert.equal(nearestSlotIndex(slots, 140), 2);
  assert.equal(nearestSlotIndex([], 10), -1);
});

test("clampDragDelta keeps the lift between the first and last row", () => {
  assert.equal(clampDragDelta(0, 200, [0, 52, 104]), 104);
  assert.equal(clampDragDelta(104, -200, [0, 52, 104]), -104);
  assert.equal(clampDragDelta(52, 10, [0, 52, 104]), 10);
  assert.equal(clampDragDelta(0, 40, []), 40);
});

test("a completed drag yields the new server id order", () => {
  const startY = 0;
  const height = 52;
  const dy = clampDragDelta(startY, 130, slots.map((slot) => slot.y));
  const to = nearestSlotIndex(slots, startY + height / 2 + dy);
  assert.deepEqual(moveServerIds(["may-test", "tom-newserver", "raft"], 0, to), [
    "tom-newserver",
    "raft",
    "may-test",
  ]);
});

test("a drag that lands on the same row does not change the order", () => {
  assert.deepEqual(moveServerIds(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
  assert.deepEqual(moveServerIds(["a", "b"], 0, -1), ["a", "b"]);
  assert.deepEqual(moveServerIds(["a", "b"], 5, 0), ["a", "b"]);
});

test("the order a drag produces is what gets saved", async () => {
  const previous = [server("a"), server("b"), server("c")];
  const nextIds = moveServerIds(previous.map((item) => item.id), 0, 2);
  assert.deepEqual(nextIds, ["b", "c", "a"]);
  useServerRailStore.getState().reset();
  useServerRailStore.setState({ servers: previous });
  let patched: unknown;
  const client: ServerRailClient = {
    get: async () => ({}),
    patch: async (_path, body) => {
      patched = body;
      return { serverOrder: nextIds };
    },
  };
  const saved = await useServerRailStore.getState().reorderServers(client, nextIds);
  assert.equal(saved, true);
  assert.deepEqual(patched, { serverOrder: ["b", "c", "a"] });
  assert.deepEqual(useServerRailStore.getState().servers.map((item) => item.id), ["b", "c", "a"]);
  useServerRailStore.getState().reset();
});

function server(id: string): RaftServer {
  return { id, name: id, slug: id };
}
