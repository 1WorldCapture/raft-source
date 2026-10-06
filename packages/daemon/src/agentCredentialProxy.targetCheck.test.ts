import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vitest";
import { TARGET_CHECK_PATH, TARGET_CHECK_SCHEMA } from "@botiverse/raft-shared";
import { registerAgentCredentialProxy, unregisterAgentCredentialProxyForLaunch, __resetAgentCredentialProxyForTest, type AgentProxyInboxCoordinator, type AgentProxyVisibleMessage } from "./agentCredentialProxy.js";
import { AgentVisibleDeliveryLedger, formatProxyVisibleMessageTarget } from "./agentVisibleDeliveryLedger.js";
import { RuntimeNotificationState, computeInboxNoticeFingerprint } from "./runtimeNotificationState.js";

type State = { pending: AgentProxyVisibleMessage[]; consumed: string[]; checks: unknown[]; coordinator: AgentProxyInboxCoordinator };
function message(id: string, channel = "a", seq = 1): AgentProxyVisibleMessage {
  return { message_id: id, seq, channel_id: `conversation-${channel}`, channel_type: "channel", channel_name: channel, sender_type: "human", sender_name: "owner", content: `private body ${id}` };
}

async function harness(run: (h: {
  add: (agentId: string, messages: AgentProxyVisibleMessage[], modify?: (state: State) => void) => Promise<{ state: State; url: string; token: string }>;
  calls: string[];
}) => Promise<void>) {
  const calls: string[] = [];
  const upstream = http.createServer((req, res) => { calls.push(req.url ?? ""); res.writeHead(404); res.end(); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  try {
    await run({
      calls,
      add: async (agentId, messages, modify) => {
        const ledger = new AgentVisibleDeliveryLedger();
        const state: State = { pending: [...messages], consumed: [], checks: [], coordinator: {} as AgentProxyInboxCoordinator };
        const consume: AgentProxyInboxCoordinator["consumeVisibleMessages"] = (input) => {
          const consumed = ledger.recordConsumed(agentId, input);
          state.consumed.push(...input.messages.map((m) => m.message_id || m.id || ""));
          if (consumed) state.pending = state.pending.filter((m) => !consumed.shouldSuppress(m as Parameters<typeof consumed.shouldSuppress>[0]));
        };
        state.coordinator = {
          getBoundary: (target) => ledger.getBoundary(agentId, target),
          getPendingMessages: (target) => state.pending.filter((m) => formatProxyVisibleMessageTarget(m) === target),
          getAllPendingMessages: () => [...state.pending],
          isMessageModelSeen: ({ target, message: value }) => ledger.isModelSeen(agentId, target, value),
          consumeVisibleMessages: consume,
          consumeTargetMessages: (page) => consume({ messages: page, source: "agent_api_events_local" }),
          recordAttentionCheck: (input) => { state.checks.push(input); },
        };
        modify?.(state);
        const handle = await registerAgentCredentialProxy({ agentId, launchId: `launch-${agentId}`, serverUrl, apiKey: "sk_agent_fake_test_only", activeCapabilities: "read", inboxCoordinator: state.coordinator });
        return { state, url: handle.proxyUrl, token: handle.proxyToken };
      },
    });
  } finally {
    await __resetAgentCredentialProxyForTest();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}
async function check(handle: { url: string; token: string }, body: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(new URL(TARGET_CHECK_PATH, handle.url), { method: "POST", headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
}

test("A token cannot read or consume B-only target, or B's copies in a shared displayed target", async () => {
  await harness(async ({ add, calls }) => {
    const a = await add("A", [message("a-shared", "shared")]);
    const b = await add("B", [message("b-shared", "shared"), message("b-only", "secret", 2)]);
    const denied = await check(a, { target: "#secret" }, { "X-Agent-Id": "B" });
    assert.equal(denied.status, 200);
    const empty = await denied.json();
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.scope, "daemon_pending_target");
    assert.equal(JSON.stringify(empty).includes("b-only"), false);
    const own = await check(a, { target: "#shared" });
    assert.deepEqual((await own.json()).messages.map((m: { message_id: string }) => m.message_id), ["a-shared"]);
    assert.equal(b.state.pending.length, 2);
    assert.deepEqual(b.state.consumed, []);
    assert.deepEqual(calls, []);
  });
});
test("forged identity fields/invalid arguments are rejected before reading or consuming", async () => {
  await harness(async ({ add, calls }) => {
    const a = await add("A", [message("a")]);
    for (const body of [{ target: "#a", agentId: "B" }, { target: "#a", launchId: "other" }, { target: "#a", limit: 0 }, { target: "#a", limit: 201 }]) {
      assert.equal((await check(a, body)).status, 400);
    }
    assert.deepEqual(a.state.consumed, []);
    assert.deepEqual(calls, []);
  });
});
test("empty, unavailable and wrong method never fall through to server events", async () => {
  await harness(async ({ add, calls }) => {
    const a = await add("A", []);
    assert.equal((await check(a, { target: "#a" })).status, 200);
    assert.equal((await fetch(new URL(TARGET_CHECK_PATH, a.url), { headers: { authorization: `Bearer ${a.token}` } })).status, 405);
    const legacy = await add("old", [message("old")], (s) => { delete s.coordinator.consumeTargetMessages; });
    assert.equal((await check(legacy, { target: "#a" })).status, 503);
    assert.deepEqual(legacy.state.consumed, []);
    assert.deepEqual(calls, []);
  });
});
test("target batch then legacy full check preserves other conversations and old route", async () => {
  await harness(async ({ add, calls }) => {
    const a = await add("A", [message("a1", "a", 1), message("b1", "b", 2), message("a2", "a", 3)]);
    const inbox = await fetch(new URL("/internal/agent-api/inbox", a.url), { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal((await inbox.json()).target_check.schema, TARGET_CHECK_SCHEMA);
    const page = await (await check(a, { target: "#a" })).json();
    assert.deepEqual(page.messages.map((m: { message_id: string }) => m.message_id), ["a1", "a2"]);
    assert.deepEqual(a.state.pending.map((m) => m.message_id), ["b1"]);
    const full = await fetch(new URL("/internal/agent-api/events?since=latest", a.url), { headers: { authorization: `Bearer ${a.token}` } });
    assert.deepEqual((await full.json()).events.map((m: { message_id: string }) => m.message_id), ["b1"]);
    assert.equal(a.state.pending.length, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(a.state.checks.map((c) => (c as { scope: string }).scope), ["target", "all"]);
  });
});
test("notice steering does not consume body; concrete exposure does not get read twice", async () => {
  await harness(async ({ add }) => {
    const pending = message("notice-only");
    const a = await add("A", [pending]);
    const notifications = new RuntimeNotificationState();
    notifications.recordNoticeWritten(computeInboxNoticeFingerprint([pending]), "session", [pending]);
    assert.equal(notifications.hasContributedMessage(pending, "session"), true);
    const first = await (await check(a, { target: "#a" })).json();
    assert.equal(first.returned_count, 1, "notice contribution is not body consumption");
    assert.equal((await (await check(a, { target: "#a" })).json()).returned_count, 0);

    const b = await add("B", [message("body-exposed"), message("new-body", "a", 2)]);
    b.state.coordinator.consumeVisibleMessages({ messages: [b.state.pending[0]!], source: "agent_api_events_local" });
    const next = await (await check(b, { target: "#a" })).json();
    assert.deepEqual(next.messages.map((m: { message_id: string }) => m.message_id), ["new-body"]);
  });
});
test("still-registered old launch token cannot inspect a new launch through the coordinator", async () => {
  await harness(async ({ add, calls }) => {
    let snapshots = 0;
    const a = await add("A", [message("new-launch-body")], (s) => {
      s.coordinator.isCurrentLaunch = () => false;
      s.coordinator.getAllPendingMessages = () => { snapshots += 1; return [...s.pending]; };
    });
    assert.equal((await check(a, { target: "#a" })).status, 401);
    assert.equal(snapshots, 0);
    assert.deepEqual(a.state.consumed, []);
    assert.deepEqual(calls, []);
  });
});

test("token revoked during preparation and revoked token requests consume nothing", async () => {
  await harness(async ({ add, calls }) => {
    const a = await add("A", [message("a")], (s) => {
      s.coordinator.getAllPendingMessages = () => {
        unregisterAgentCredentialProxyForLaunch({ agentId: "A", launchId: "launch-A" });
        return [...s.pending];
      };
    });
    assert.equal((await check(a, { target: "#a" })).status, 401);
    assert.equal((await check(a, { target: "#a" })).status, 401);
    assert.deepEqual(a.state.consumed, []);
    assert.deepEqual(calls, []);
  });
});
test("ambiguous target does not consume any member", async () => {
  await harness(async ({ add, calls }) => {
    const a = await add("A", [message("one", "same"), { ...message("two", "same", 2), channel_id: "different" }]);
    const response = await check(a, { target: "#same" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "TARGET_AMBIGUOUS");
    assert.deepEqual(a.state.consumed, []);
    assert.deepEqual(calls, []);
  });
});
test("telemetry exceptions do not affect successful consumption", async () => {
  await harness(async ({ add }) => {
    const a = await add("A", [message("a")], (s) => { s.coordinator.recordAttentionCheck = () => { throw new Error("test trace failure"); }; });
    assert.equal((await check(a, { target: "#a" })).status, 200);
    assert.deepEqual(a.state.consumed, ["a"]);
  });
});
