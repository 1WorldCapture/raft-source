import assert from "node:assert/strict";
import test from "node:test";
import { TARGET_CHECK_PATH } from "@botiverse/raft-shared";
import { messageCheckCommand } from "./check.js";
import { createCommandContext } from "../../core/context.js";
import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse, ApiClient } from "../../client.js";
import { CliError } from "../../core/errors.js";
import { formatInboxSnapshot } from "../inbox/_format.js";

function harness(response: ApiResponse<unknown>, mode: AgentContext["clientMode"] = "managed-runner") {
  const stdout: string[] = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const context: AgentContext = { agentId: "agent-a", serverId: "server", serverUrl: "http://127.0.0.1", token: "sap_test_only", clientMode: mode, secretSource: "profile-credential-file", activeCapabilities: null };
  const ctx = createCommandContext({
    io: { stdout: { write: (text) => { stdout.push(String(text)); return true; } }, stderr: { write: () => true } },
    loadAgentContext: () => context,
    createApiClient: () => ({ request: async (method: string, path: string, body?: unknown) => { requests.push({ method, path, body }); return response; } }) as unknown as ApiClient,
  });
  return { ctx, requests, stdout };
}
function page(messages: unknown[] = [], remaining = 0): ApiResponse<unknown> {
  return { ok: true, status: 200, error: null, data: { scope: "daemon_pending_target", target: "#a", messages, returned_count: messages.length, remaining_count: remaining, has_more: remaining > 0 } };
}
const body = { message_id: "12345678-0000-4000-8000-000000000000", seq: 3, channel_type: "channel", channel_name: "a", sender_type: "human", sender_name: "owner", content: "read together" };

test("target check makes exactly one typed local POST and preserves the full body", async () => {
  const h = harness(page([body], 1));
  await messageCheckCommand.handler(h.ctx, { target: "#a", limit: "50" });
  assert.deepEqual(h.requests, [{ method: "POST", path: TARGET_CHECK_PATH, body: { target: "#a", limit: 50 } }]);
  assert.match(h.stdout.join(""), /read together/);
  assert.match(h.stdout.join(""), /1 more pending for this target/);
});
test("target empty output is local scope, not no-work or global history", async () => {
  const h = harness(page());
  await messageCheckCommand.handler(h.ctx, { target: "#a" });
  assert.match(h.stdout.join(""), /current daemon inbox/);
  assert.match(h.stdout.join(""), /not a statement about server history/);
  assert.equal(h.requests.length, 1);
});
test("target invalid arguments make zero requests", async () => {
  for (const opts of [{ limit: "2" }, { target: "" }, { target: "#a", limit: "1.5" }, { target: "#a", limit: "201" }, { target: "#a", limit: "-1" }]) {
    const h = harness(page());
    await assert.rejects(async () => { await messageCheckCommand.handler(h.ctx, opts); }, (e: unknown) => e instanceof CliError && e.code === "INVALID_ARG");
    assert.deepEqual(h.requests, []);
  }
});
test("self-hosted target check fails before any request, without global fallback", async () => {
  const h = harness(page(), "self-hosted-runner");
  await assert.rejects(async () => { await messageCheckCommand.handler(h.ctx, { target: "#a" }); }, (e: unknown) => e instanceof CliError && e.code === "TARGET_CHECK_UNSUPPORTED");
  assert.deepEqual(h.requests, []);
});
test("old daemon 404 and 405 are unsupported and never fall back", async () => {
  for (const status of [404, 405]) {
    const h = harness({ ok: false, status, data: null, error: "unsupported" });
    await assert.rejects(async () => { await messageCheckCommand.handler(h.ctx, { target: "#a" }); }, (e: unknown) => e instanceof CliError && e.code === "TARGET_CHECK_UNSUPPORTED");
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]?.path, TARGET_CHECK_PATH);
  }
});
test("target errors preserve local reason instead of returning empty success", async () => {
  for (const code of ["TARGET_CHECK_UNAVAILABLE", "TARGET_AMBIGUOUS", "TARGET_METADATA_UNAVAILABLE", "MESSAGE_TOO_LARGE"] as const) {
    const h = harness({ ok: false, status: code === "MESSAGE_TOO_LARGE" ? 413 : 409, data: null, error: code, errorCode: code });
    await assert.rejects(async () => { await messageCheckCommand.handler(h.ctx, { target: "#a" }); }, (e: unknown) => e instanceof CliError && e.code === code);
    assert.equal(h.requests.length, 1);
  }
});
test("malformed or wrong-target response is rejected without fallback", async () => {
  for (const data of [{}, { ...page().data as object, target: "#b" }]) {
    const h = harness({ ok: true, status: 200, error: null, data });
    await assert.rejects(async () => { await messageCheckCommand.handler(h.ctx, { target: "#a" }); }, (e: unknown) => e instanceof CliError && e.code === "INVALID_JSON_RESPONSE");
    assert.equal(h.requests.length, 1);
  }
});
test("inbox recommendation requires target-check metadata, but rows and coarse ordering survive old daemon", () => {
  const rows = [
    { target: "#a", pendingCount: 1, flags: [] },
    { target: "dm:@owner", pendingCount: 1, flags: [], attentionPriority: "human_dm" as const },
  ];
  const legacy = formatInboxSnapshot(rows);
  assert.match(legacy, /#a/);
  assert.doesNotMatch(legacy, /check --target/);
  const modern = formatInboxSnapshot(rows, ["dm:@owner", "#a"]);
  assert.match(modern, /check --target 'dm:@owner'/);
  assert.match(modern, /finish your current step/);
  assert.ok(modern.indexOf("dm:@owner") < modern.indexOf("#a"));
});
