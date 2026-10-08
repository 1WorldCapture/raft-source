import assert from "node:assert/strict";
import test from "node:test";
import { isPmDirectMessage, parsePmAgentChoices, parsePmTabState } from "./pmState.ts";

test("parsePmTabState keeps the setup tri-state and the caller's DM", () => {
  const parsed = parsePmTabState({
    pm: { agentId: "agent-1", name: "pm", displayName: "PM" },
    dmChannelId: "dm-1",
    setup: "set",
  });
  assert.deepEqual(parsed, {
    pm: { agentId: "agent-1", name: "pm", displayName: "PM" },
    dmChannelId: "dm-1",
    setup: "set",
  });
});

test("parsePmTabState accepts a missing PM", () => {
  assert.deepEqual(parsePmTabState({ pm: null, dmChannelId: null, setup: "unset" }), {
    pm: null,
    dmChannelId: null,
    setup: "unset",
  });
  assert.equal(parsePmTabState({ pm: null, setup: "later" }), null);
});

test("parsePmAgentChoices skips deleted agents", () => {
  assert.deepEqual(parsePmAgentChoices({
    agents: [
      { id: "a", name: "alpha", displayName: "Alpha" },
      { id: "b", name: "gone", deletedAt: "2026-01-01" },
    ],
  }), [{ id: "a", name: "Alpha" }]);
});

test("isPmDirectMessage matches only the PM agent's DM", () => {
  assert.equal(isPmDirectMessage({ type: "dm", peerType: "agent", peerId: "pm" }, "pm"), true);
  assert.equal(isPmDirectMessage({ type: "dm", peerType: "agent", peerId: "other" }, "pm"), false);
  assert.equal(isPmDirectMessage({ type: "dm", peerType: "user", peerId: "pm" }, "pm"), false);
  assert.equal(isPmDirectMessage({ type: "channel", peerType: "agent", peerId: "pm" }, "pm"), false);
});
