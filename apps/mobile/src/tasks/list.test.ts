import assert from "node:assert/strict";
import test from "node:test";
import type { RaftTask } from "./model";
import {
  channelChoices,
  defaultCollapsed,
  filterTasks,
  hasTaskFilter,
  parseTaskFilters,
  peopleChoices,
  plainDescription,
  toggleChoice,
} from "./list";

function task(patch: Partial<RaftTask>): RaftTask {
  return {
    id: "t1",
    messageId: "m1",
    channelId: "c1",
    channelName: "all",
    channelType: "channel",
    taskNumber: 1,
    title: "One",
    description: null,
    status: "todo",
    createdByType: "user",
    createdById: "u1",
    createdByName: "Ada",
    claimedByType: null,
    claimedById: null,
    claimedByName: null,
    createdAt: null,
    updatedAt: null,
    revision: 1,
    isLegacy: false,
    ...patch,
  };
}

test("filters AND across chips and OR within a chip, including unassigned", () => {
  const tasks = [
    task({ id: "a", channelId: "c1", createdById: "u1", claimedByType: "user", claimedById: "u2" }),
    task({ id: "b", channelId: "c2", createdById: "u1" }),
    task({ id: "c", channelId: "c1", createdByType: "agent", createdById: "bot" }),
  ];
  assert.deepEqual(filterTasks(tasks, { channels: ["c1"], creators: [], assignees: [] }).map((item) => item.id), ["a", "c"]);
  assert.deepEqual(filterTasks(tasks, { channels: ["c1"], creators: ["user:u1"], assignees: [] }).map((item) => item.id), ["a"]);
  assert.deepEqual(filterTasks(tasks, { channels: [], creators: ["user:u1", "agent:bot"], assignees: [] }).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(filterTasks(tasks, { channels: [], creators: [], assignees: ["unassigned"] }).map((item) => item.id), ["b", "c"]);
  assert.deepEqual(filterTasks(tasks, { channels: [], creators: [], assignees: ["unassigned", "user:u2"] }).map((item) => item.id), ["a", "b", "c"]);
  assert.equal(hasTaskFilter({ channels: [], creators: [], assignees: [] }), false);
  assert.equal(hasTaskFilter({ channels: ["c1"], creators: [], assignees: [] }), true);
});

test("done and closed start collapsed", () => {
  assert.deepEqual(defaultCollapsed(), {
    todo: false,
    in_progress: false,
    in_review: false,
    done: true,
    closed: true,
  });
});

test("channel choices keep public and private channels and drop dms", () => {
  const choices = channelChoices(
    [
      { id: "c2", name: "zeta", type: "channel" },
      { id: "dm1", name: "Lyon", type: "dm" },
      { id: "p1", name: "boxtest-private", type: "private" },
      { id: "j1", name: "joint", type: "joint" },
    ],
    [task({ channelId: "c9", channelName: "#alpha" })],
  );
  assert.deepEqual(choices.map((choice) => choice.label), ["#alpha", "#boxtest-private", "#zeta"]);
});

test("people choices prefer display names and skip deleted agents", () => {
  const choices = peopleChoices(
    { agents: [{ id: "a1", name: "bot", displayName: "Builder" }, { id: "a2", name: "gone", deletedAt: "2026-01-01" }] },
    [{ userId: "u1", name: "ada", displayName: "Ada" }],
  );
  assert.deepEqual(choices, [
    { id: "user:u1", label: "Ada" },
    { id: "agent:a1", label: "Builder" },
  ]);
});

test("stored filters ignore malformed payloads", () => {
  assert.deepEqual(parseTaskFilters(null), { channels: [], creators: [], assignees: [] });
  assert.deepEqual(parseTaskFilters("{"), { channels: [], creators: [], assignees: [] });
  assert.deepEqual(parseTaskFilters(JSON.stringify({ channels: ["c1", 2], creators: "nope", assignees: ["unassigned"] })), {
    channels: ["c1"],
    creators: [],
    assignees: ["unassigned"],
  });
  assert.deepEqual(toggleChoice(["c1"], "c2"), ["c1", "c2"]);
  assert.deepEqual(toggleChoice(["c1", "c2"], "c1"), ["c2"]);
  assert.equal(plainDescription("  hello\n\nworld  "), "hello world");
  assert.equal(plainDescription(null), "");
});
