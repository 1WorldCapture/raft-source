import assert from "node:assert/strict";
import { test } from "vitest";
import { prepareTargetCheck, TargetCheckError } from "./agentInboxTargetCheck.js";
import { eligibleInboxTargetRefs, projectAgentInboxSnapshot } from "./agentInboxProjection.js";
import type { AgentProxyVisibleMessage } from "./agentCredentialProxy.js";
import { AttentionObservation } from "./attentionObservation.js";

function message(id: string, seq: number, extra: Partial<AgentProxyVisibleMessage> = {}): AgentProxyVisibleMessage {
  return { message_id: id, seq, channel_id: "channel-a", channel_type: "channel", channel_name: "a", sender_type: "human", sender_name: "owner", content: `body ${id}`, ...extra };
}
function code(expected: string) { return (error: unknown) => error instanceof TargetCheckError && error.code === expected; }

test("target check prepares all senders of one conversation, not just the trigger; other target unchanged", () => {
  const pending = [message("3", 3, { sender_type: "agent", mentioned: true }), message("2", 2, { channel_id: "channel-b", channel_name: "b" }), message("1", 1)];
  const before = structuredClone(pending);
  const plan = prepareTargetCheck(pending, { target: "#a" });
  assert.deepEqual(plan.response.messages.map((m) => m.message_id), ["1", "3"]);
  assert.deepEqual(pending, before);
  assert.equal(plan.response.scope, "daemon_pending_target");
});
test("active/starting duplicates are returned once with original metadata for exact-ID consumption", () => {
  const first = message("1", 1);
  const plan = prepareTargetCheck([first, { ...first }], { target: "#a" });
  assert.equal(plan.response.returned_count, 1);
  assert.equal(plan.consumedMessages[0], first);
});
test("thread short ref agrees with Inbox projection and never includes parent/sibling", () => {
  const thread = message("t", 4, { channel_id: "thread-a", channel_type: "thread", channel_name: "thread-12345678-0000-4000-8000-000000000000", parent_channel_name: "a", parent_channel_type: "channel" });
  const sibling = { ...thread, message_id: "s", channel_id: "thread-b", channel_name: "thread-87654321-0000-4000-8000-000000000000" };
  const pending = [message("parent", 1), thread, sibling];
  const row = projectAgentInboxSnapshot(pending).find((r) => r.channelId === "thread-a")!;
  assert.equal(row.target, "#a:12345678");
  assert.deepEqual(prepareTargetCheck(pending, { target: row.target }).consumedMessages, [thread]);
});
test("DM and its DM thread have separate batches but the same DM priority", () => {
  const dm = message("dm", 1, { channel_id: "dm", channel_name: "owner", channel_type: "dm" });
  const thread = message("thread", 2, { channel_id: "dm-thread", channel_type: "thread", channel_name: "thread-12345678-0000-4000-8000-000000000000", parent_channel_name: "owner", parent_channel_type: "dm" });
  assert.deepEqual(projectAgentInboxSnapshot([dm, thread]).map((r) => r.attentionPriority), ["human_dm", "human_dm"]);
  assert.deepEqual(prepareTargetCheck([dm, thread], { target: "dm:@owner" }).consumedMessages, [dm]);
});
test("same displayed short ref with different actual conversations is ambiguous and not recommended", () => {
  const a = message("a", 1, { channel_id: "thread-a", channel_type: "thread", channel_name: "thread-12345678-0000-4000-8000-000000000000", parent_channel_name: "a", parent_channel_type: "channel" });
  const b = { ...a, message_id: "b", channel_id: "thread-b", channel_name: "thread-12345678-ffff-4000-8000-000000000000" };
  assert.throws(() => prepareTargetCheck([a, b], { target: "#a:12345678" }), code("TARGET_AMBIGUOUS"));
  assert.equal(eligibleInboxTargetRefs([a, b]).size, 0);
});
test("local-empty result neither includes other target nor claims server history is empty", () => {
  const plan = prepareTargetCheck([message("a", 1)], { target: "#b" });
  assert.equal(plan.response.returned_count, 0);
  assert.equal(plan.response.has_more, false);
  assert.equal(plan.consumedMessages.length, 0);
});
test("a page freezes members and leaves later arrival for a future request", () => {
  const pending = [message("1", 1), message("2", 2), message("3", 3)];
  const plan = prepareTargetCheck(pending, { target: "#a", limit: 2 });
  pending.push(message("4", 4));
  assert.deepEqual(plan.response.messages.map((m) => m.message_id), ["1", "2"]);
  assert.equal(plan.response.remaining_count, 1);
  assert.equal(plan.response.has_more, true);
});
test("missing stable IDs/actual conversation identity are rejected before consumption", () => {
  assert.throws(() => prepareTargetCheck([message("", 1)], { target: "#a" }), code("TARGET_METADATA_UNAVAILABLE"));
  assert.throws(() => prepareTargetCheck([message("a", 1, { channel_id: undefined })], { target: "#a" }), code("TARGET_METADATA_UNAVAILABLE"));
  assert.throws(() => prepareTargetCheck([message("a", 1, { content: undefined })], { target: "#a" }), code("TARGET_METADATA_UNAVAILABLE"));
});
test("runtime controls and third-party events do not enter a normal target check", () => {
  const pending = [message("runtime-profile-daemon-release-x", 1), message("event", 2, { third_party_event: { id: "event" } })];
  assert.equal(eligibleInboxTargetRefs(pending).size, 0);
  assert.equal(prepareTargetCheck(pending, { target: "#a" }).response.returned_count, 0);
});
test("non-member mention is only the already-delivered body; original limitation preserved", () => {
  const plan = prepareTargetCheck([message("a", 1, { non_member_mention: true, mentioned: true })], { target: "#a" });
  assert.equal(plan.response.messages[0]?.non_member_mention, true);
});
test("invalid response metadata fails before a plan can be consumed", () => {
  const invalid = { ...message("a", 1), attachments: "not-an-array" };
  assert.throws(() => prepareTargetCheck([invalid], { target: "#a" }), code("TARGET_CHECK_INVALID_RESPONSE"));
});
test("UTF-8/JSON-escaped body budget returns complete prefix only", () => {
  const a = message("a", 1, { content: '代码\n"quoted"'.repeat(20) });
  const one = prepareTargetCheck([a], { target: "#a" });
  const limit = Buffer.byteLength(one.serialized) + 5;
  const b = message("b", 2, { content: "x".repeat(1000) });
  const plan = prepareTargetCheck([a, b], { target: "#a" }, limit);
  assert.equal(plan.response.returned_count, 1);
  assert.equal(plan.response.remaining_count, 1);
  assert.equal(plan.response.messages[0]?.content, a.content);
  assert.ok(Buffer.byteLength(plan.serialized) <= limit);
});
test("first oversized message is not truncated or consumed", () => {
  assert.throws(() => prepareTargetCheck([message("huge", 1, { content: "汉".repeat(1000) })], { target: "#a" }, 400), code("MESSAGE_TOO_LARGE"));
});
test("serialized attachment metadata counts against the same byte budget as message bodies", () => {
  const withAttachment = { ...message("attachment", 1), attachments: [{ id: "attachment-1", filename: "长文件名".repeat(400), mimeType: "text/plain", sizeBytes: 1 }] };
  const full = prepareTargetCheck([withAttachment], { target: "#a" });
  assert.ok(Buffer.byteLength(full.serialized, "utf8") > 1000);
  assert.throws(() => prepareTargetCheck([withAttachment], { target: "#a" }, 500), code("MESSAGE_TOO_LARGE"));
});

test("conflicting duplicate copies fail closed", () => {
  assert.throws(() => prepareTargetCheck([message("same", 1), message("same", 1, { content: "different" })], { target: "#a" }), code("TARGET_METADATA_UNAVAILABLE"));
});
test("observation links one first check, not every HTTP page, and session changes unlink", () => {
  const observation = new AttentionObservation();
  const attrs = observation.present({ target: "#a", kind: "human_mention" }, "s1");
  const error = observation.check({ scope: "target", target: "#a", outcome: "failed" }, "s1");
  assert.equal(error["attention.first_check"], false);
  const first = observation.check({ scope: "target", target: "#a", outcome: "returned" }, "s1");
  assert.equal(first["attention.recommendation_id"], attrs["attention.recommendation_id"]);
  assert.equal(first["attention.followed_recommendation"], true);
  assert.equal(observation.check({ scope: "all", outcome: "returned" }, "s1")["attention.first_check"], false);
  assert.equal(observation.check({ scope: "target", target: "#a", outcome: "returned" }, "s2")["attention.linked"], false);
});
