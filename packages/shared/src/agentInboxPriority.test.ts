import assert from "node:assert/strict";
import test from "node:test";
import { aggregateInboxPriority, classifyInboxMessage, formatInboxPriorityRecommendation, rankInboxTargets, recommendInboxTarget, type InboxPriorityKind } from "./agentInboxPriority.js";
import type { AgentInboxTargetRow } from "./agentInbox.js";
import { daemonApiInboxTargetCheckBodySchema, daemonApiInboxTargetCheckResponseSchema, parseDaemonApiResponse } from "./daemonApiContract.js";

function row(target: string, priority?: InboxPriorityKind | (string & {}), seq = 1): AgentInboxTargetRow {
  return { target, flags: [], pendingCount: 1, firstPendingSeq: seq, ...(priority ? { attentionPriority: priority } : {}) };
}
for (const sender of ["human", "agent"] as const) {
  for (const thread of [false, true]) {
    test(`${sender} DM${thread ? " thread" : ""} has its DM tier`, () => {
      assert.equal(classifyInboxMessage({ sender_type: sender, channel_type: thread ? "thread" : "dm", parent_channel_type: thread ? "dm" : undefined }), `${sender}_dm`);
    });
  }
}
test("human DM > human mention > agent DM > agent mention > ordinary without mutating input", () => {
  const rows = [row("#o", "ordinary"), row("dm:@bot", "agent_dm"), row("#am", "agent_mention"), row("#hm", "human_mention"), row("dm:@owner", "human_dm")];
  const original = [...rows];
  assert.deepEqual(rankInboxTargets(rows).map((r) => r.attentionPriority), ["human_dm", "human_mention", "agent_dm", "agent_mention", "ordinary"]);
  assert.deepEqual(rows, original);
});
test("mixed senders use strongest same-message evidence, not latest sender", () => {
  assert.equal(aggregateInboxPriority([
    { channel_type: "dm", sender_type: "human" }, { channel_type: "dm", sender_type: "agent" },
  ]), "human_dm");
  assert.equal(aggregateInboxPriority([
    { channel_type: "channel", sender_type: "agent", mentioned: true },
    { channel_type: "channel", sender_type: "human", mentioned: false },
  ]), "agent_mention");
  assert.equal(aggregateInboxPriority([{ channel_type: "channel", sender_type: "agent", mentioned: true }]), "agent_mention");
});
test("unknown, system, third-party and conflicting aliases cannot claim human priority", () => {
  for (const sender_type of [undefined, "user", "system", "third_party_app", "future_sender"]) {
    assert.equal(classifyInboxMessage({ sender_type, channel_type: "dm", mentioned: true }), "ordinary");
  }
  assert.equal(classifyInboxMessage({ sender_type: "agent", senderType: "human", channel_type: "dm" }), "ordinary");
});
test("within a priority, first pending sequence is stable; missing values sort last", () => {
  const rows = [row("#z", "ordinary", NaN), row("#c", "ordinary", 9), row("#b", "ordinary", 2), row("#a", "ordinary", 2)];
  assert.deepEqual(rankInboxTargets(rows).map((r) => r.target), ["#a", "#b", "#c", "#z"]);
});
test("suppressed-only rows remain visible but cannot be recommended", () => {
  const rows = [{ ...row("dm:@owner", "human_dm"), pendingCount: 0, suppressedCount: 3 }, row("#work", "ordinary")];
  const ranked = rankInboxTargets(rows);
  assert.equal(ranked.length, 2);
  assert.equal(recommendInboxTarget(ranked, new Set(rows.map((r) => r.target)))?.target, "#work");
});
test("unknown priority tolerates schema and does not gain authority; legacy latestSenderType is not a signal", () => {
  const legacy = { ...row("dm:@old"), latestSenderType: "human" as const };
  assert.equal(recommendInboxTarget([legacy], new Set([legacy.target])), null);
  const parsed = parseDaemonApiResponse("inboxCheck", { rows: [row("dm:@new", "future_priority")] });
  assert.equal(parsed.rows?.length, 1);
  assert.equal(recommendInboxTarget([row("#future", "future_priority")], new Set(["#future"])), null);
});
test("recommendation is eligible and warns against abandoning current work", () => {
  const ranked = rankInboxTargets([row("dm:@owner", "human_dm"), row("#work", "human_mention")]);
  const recommendation = recommendInboxTarget(ranked, new Set(["#work"]));
  const text = formatInboxPriorityRecommendation(recommendation, "updates");
  assert.match(text, /among these updates/);
  assert.match(text, /finish your current step before switching/);
  assert.match(text, /check --target '#work'/);
  assert.equal(formatInboxPriorityRecommendation(null, "snapshot"), "");
});
test("hostile target is never interpolated into a generated executable command", () => {
  const text = formatInboxPriorityRecommendation({ target: "#x'$(touch pwn)", kind: "ordinary" }, "updates");
  assert.doesNotMatch(text, /check --target '#x/);
});
for (const body of [
  { target: "#x", agentId: "other" }, { target: "#x", serverId: "other" }, { target: "" },
  { target: "#x", limit: 0 }, { target: "#x", limit: 201 }, { target: "#x", limit: 1.5 },
  { target: "#x", limit: "50" }, { target: "#x\nforged" },
]) {
  test(`target request rejects ${JSON.stringify(body)}`, () => assert.equal(daemonApiInboxTargetCheckBodySchema.safeParse(body).success, false));
}
test("target response verifies count consistency", () => {
  assert.equal(daemonApiInboxTargetCheckResponseSchema.safeParse({ scope: "daemon_pending_target", target: "#x", messages: [], returned_count: 1, remaining_count: 0, has_more: false }).success, false);
  assert.equal(daemonApiInboxTargetCheckBodySchema.parse({ target: "dm:@owner:12345678", limit: 200 }).limit, 200);
});
