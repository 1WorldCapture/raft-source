import assert from "node:assert/strict";
import test from "node:test";
import { derivePresence, derivePresenceFromActivity } from "./agentPresence.js";

test("derivePresence maps busy activities onto working", () => {
  assert.equal(derivePresence({ activity: "thinking" }), "working");
  assert.equal(derivePresence({ activity: "working" }), "working");
});

test("derivePresence maps online and error onto idle", () => {
  assert.equal(derivePresence({ activity: "online" }), "idle");
  assert.equal(derivePresence({ activity: "error" }), "idle");
});

test("derivePresence: offline activity always wins", () => {
  assert.equal(derivePresence({ activity: "offline", lifecycleStatus: "active", machineStatus: "online" }), "offline");
});

test("derivePresence: a known non-active lifecycle status forces offline", () => {
  assert.equal(derivePresence({ activity: "working", lifecycleStatus: "stopped" }), "offline");
  assert.equal(derivePresence({ activity: "working", lifecycleStatus: "inactive" }), "offline");
  assert.equal(derivePresence({ activity: "online", lifecycleStatus: "active" }), "idle");
});

test("derivePresence: unknown lifecycle status does not trigger offline", () => {
  assert.equal(derivePresence({ activity: "working", lifecycleStatus: null }), "working");
  assert.equal(derivePresence({ activity: "working", lifecycleStatus: undefined }), "working");
  assert.equal(derivePresence({ activity: "working", lifecycleStatus: "" }), "working");
});

test("derivePresence: an offline machine forces offline", () => {
  assert.equal(derivePresence({ activity: "online", lifecycleStatus: "active", machineStatus: "offline" }), "offline");
});

test("derivePresence: unknown machine status does not trigger offline", () => {
  assert.equal(derivePresence({ activity: "online", machineStatus: null }), "idle");
  assert.equal(derivePresence({ activity: "working", machineStatus: undefined }), "working");
  // Locally-connected machine fact keeps the busy projection intact.
  assert.equal(derivePresence({ activity: "working", machineStatus: "online" }), "working");
});

test("derivePresence: offline facts win in order activity, lifecycle, machine", () => {
  // All three offline facts at once still just read offline.
  assert.equal(derivePresence({
    activity: "offline",
    lifecycleStatus: "stopped",
    machineStatus: "offline",
  }), "offline");
});

test("derivePresence: unknown activity strings degrade to idle, never offline", () => {
  assert.equal(derivePresence({ activity: "streaming" }), "idle");
  assert.equal(derivePresence({ activity: null }), "idle");
  assert.equal(derivePresence({ activity: undefined }), "idle");
  assert.equal(derivePresence({ activity: "" }), "idle");
});

test("derivePresenceFromActivity positional wrapper matches the object form", () => {
  assert.equal(derivePresenceFromActivity("working", "active", "online"), "working");
  assert.equal(derivePresenceFromActivity("working", "stopped"), "offline");
  assert.equal(derivePresenceFromActivity("online", null, "offline"), "offline");
  assert.equal(derivePresenceFromActivity("online"), "idle");
});
