import assert from "node:assert/strict";
import test from "node:test";
import {
  assigneePeople,
  historyPointStatus,
  historyStatusChange,
  historyTitleId,
  matchingPeople,
  parseTaskHistory,
  visibleTaskHistory,
} from "./history.ts";

test("parseTaskHistory keeps complete events and drops a broken row", () => {
  const events = parseTaskHistory({
    events: [
      { id: "e1", eventType: "created", actorType: "user", actorName: "Lyon", createdAt: "2026-09-26T00:00:00Z", payload: { status: "todo", taskNumber: 19 } },
      { id: "bad" },
      { eventType: "closed" },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actorName, "Lyon");
  assert.equal(events[0]?.payload.status, "todo");
});

test("visible history hides resource receipts", () => {
  const events = visibleTaskHistory([
    { id: "e1", eventType: "created", actorType: "user", actorName: null, createdAt: "", payload: {} },
    { id: "e2", eventType: "resource_receipt_recorded", actorType: "agent", actorName: null, createdAt: "", payload: {} },
  ]);
  assert.deepEqual(events.map((event) => event.id), ["e1"]);
});

test("history titles and status dots follow the web event names", () => {
  assert.equal(historyTitleId("assignee_changed"), "task.history.assigneeChanged");
  assert.equal(historyTitleId("other"), null);
  assert.equal(historyPointStatus({ id: "e", eventType: "status_changed", actorType: "user", actorName: null, createdAt: "", payload: { from: "todo", to: "in_progress" } }), "in_progress");
  assert.equal(historyPointStatus({ id: "e", eventType: "reopened", actorType: "user", actorName: null, createdAt: "", payload: {} }), "in_progress");
  assert.deepEqual(
    historyStatusChange({ id: "e", eventType: "closed", actorType: "user", actorName: null, createdAt: "", payload: { from: "todo", to: "closed" } }),
    { from: "todo", to: "closed" },
  );
  assert.equal(historyStatusChange({ id: "e", eventType: "created", actorType: "user", actorName: null, createdAt: "", payload: { from: "todo", to: "closed" } }), null);
});

test("assignee people keep humans then agents and skip a deleted agent", () => {
  const people = assigneePeople({
    humans: [{ id: "u1", displayName: "Box Test", name: "boxtest" }],
    agents: [{ id: "a1", name: "Firstmate" }, { id: "a2", name: "Gone", deletedAt: "2026-09-26" }],
  });
  assert.deepEqual(people.map((person) => person.label), ["Box Test", "Firstmate"]);
  assert.deepEqual(matchingPeople(people, "first").map((person) => person.id), ["a1"]);
});
