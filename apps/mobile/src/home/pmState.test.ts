import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteDb } from "../cache/portNode.ts";
import { __resetCacheRuntimeSingleton, initCacheRuntime } from "../cache/runtime.ts";
import { isPmDirectMessage, parsePmAgentChoices, parsePmTabState, PM_TAB_CACHE_KEY, pmTabCacheRecord, selectPmBody } from "./pmState.ts";

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
    autoProvision: false,
  });
});

test("parsePmTabState treats a missing autoProvision as an old server", () => {
  assert.equal(parsePmTabState({ pm: null, dmChannelId: null, setup: "dismissed" })?.autoProvision, false);
  assert.equal(parsePmTabState({ pm: null, dmChannelId: null, setup: "dismissed", autoProvision: true })?.autoProvision, true);
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

test("selectPmBody keeps unknown results on the spinner and empty copy behind a real payload", () => {
  const empty = { pm: null, dmChannelId: null, setup: "dismissed" as const, autoProvision: false };
  assert.equal(selectPmBody({ role: null, roleKnown: false, loading: true, error: null, state: null, choosing: false }), "loading");
  assert.equal(selectPmBody({ role: null, roleKnown: false, loading: false, error: null, state: null, choosing: false }), "loading");
  assert.equal(selectPmBody({ role: "member", roleKnown: true, loading: false, error: "Couldn't load", state: null, choosing: false }), "error");
  assert.equal(selectPmBody({ role: null, roleKnown: false, loading: true, error: null, state: { pm: { agentId: "a", name: "PM", displayName: "PM" }, dmChannelId: "dm", setup: "set", autoProvision: false }, choosing: false }), "conversation");
  assert.equal(selectPmBody({ role: null, roleKnown: false, loading: false, error: null, state: empty, choosing: false }), "loading");
  assert.equal(selectPmBody({ role: "member", roleKnown: true, loading: true, error: null, state: empty, choosing: false }), "waitPick");
  assert.equal(selectPmBody({ role: "owner", roleKnown: true, loading: false, error: null, state: { ...empty, setup: "unset" }, choosing: false }), "setup");
});

test("pm tab cache round-trips through getKvSync", async () => {
  __resetCacheRuntimeSingleton();
  const runtime = initCacheRuntime({ openDb: () => openNodeSqliteDb(":memory:") });
  const scope = runtime.attach("https://raft.example", "user-1", "srv-a");
  const state = parsePmTabState({
    pm: { agentId: "agent-1", name: "pm", displayName: "PM" },
    dmChannelId: "dm-1",
    setup: "set",
    autoProvision: false,
  });
  assert.ok(state);
  await runtime.repo.putKv(scope, PM_TAB_CACHE_KEY, pmTabCacheRecord(state));
  assert.deepEqual(parsePmTabState(runtime.repo.getKvSync(scope, PM_TAB_CACHE_KEY)), state);
});
