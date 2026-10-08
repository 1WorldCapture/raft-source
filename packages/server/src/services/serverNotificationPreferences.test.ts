import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  resolveServerPushSuppressionForPipeline,
  type ServerPushPipelineSurface,
} from "./messageService.js";
import { shouldSuppressServerPush } from "./serverService.js";

test("server push mode all delivers ordinary and mentioned messages", () => {
  assert.equal(shouldSuppressServerPush("all", { mentioned: false, isDm: false }), false);
  assert.equal(shouldSuppressServerPush("all", { mentioned: true, isDm: false }), false);
});

test("server push mode mentions suppresses ordinary messages but pierces for mentions", () => {
  assert.equal(shouldSuppressServerPush("mentions", { mentioned: false, isDm: false }), true);
  assert.equal(shouldSuppressServerPush("mentions", { mentioned: true, isDm: false }), false);
});

test("server push mode none suppresses both ordinary and mentioned messages", () => {
  assert.equal(shouldSuppressServerPush("none", { mentioned: false, isDm: false }), true);
  assert.equal(shouldSuppressServerPush("none", { mentioned: true, isDm: true }), true);
});

test("pm_dm_mentions profile pushes DMs and mentions, suppresses other channel traffic", () => {
  // DM (any DM the user participates in — including the PM's DM) pierces.
  assert.equal(shouldSuppressServerPush("pm_dm_mentions", { mentioned: false, isDm: true }), false);
  // Channel mention pierces.
  assert.equal(shouldSuppressServerPush("pm_dm_mentions", { mentioned: true, isDm: false }), false);
  // Ordinary channel traffic — even from the PM agent — stays silent.
  assert.equal(shouldSuppressServerPush("pm_dm_mentions", { mentioned: false, isDm: false }), true);
});

for (const surface of ["direct_or_local", "joint_channel", "joint_thread"] satisfies ServerPushPipelineSurface[]) {
  test(`${surface} pipeline passes only resolved target-visible mentions to mentions-only suppression`, async () => {
    const resolveSuppressedUserIds = async (
      _serverId: string,
      userIds: string[],
      targetVisibleMentionedUserIds: ReadonlySet<string>,
      _message: { channelType: string },
    ) => new Set(userIds.filter((userId) => shouldSuppressServerPush(
      "mentions",
      { mentioned: targetVisibleMentionedUserIds.has(userId), isDm: false },
    )));

    const ordinary = await resolveServerPushSuppressionForPipeline({
      surface,
      serverId: "server-target",
      targetUserIds: ["ordinary-user"],
      targetVisibleMentionedUserIds: new Set(),
      channelType: "channel",
      resolveSuppressedUserIds,
    });
    assert.deepEqual([...ordinary], ["ordinary-user"]);

    const resolvedVisibleMention = await resolveServerPushSuppressionForPipeline({
      surface,
      serverId: "server-target",
      targetUserIds: ["mentioned-user"],
      targetVisibleMentionedUserIds: new Set(["mentioned-user"]),
      channelType: "channel",
      resolveSuppressedUserIds,
    });
    assert.deepEqual([...resolvedVisibleMention], []);

    const unresolvedOrNonVisibleMention = await resolveServerPushSuppressionForPipeline({
      surface,
      serverId: "server-target",
      targetUserIds: ["unresolved-user"],
      targetVisibleMentionedUserIds: new Set(),
      channelType: "channel",
      resolveSuppressedUserIds,
    });
    assert.deepEqual([...unresolvedOrNonVisibleMention], ["unresolved-user"]);
  });
}

test("all three production push callsites bind the target-visible mention audience and the channel type", () => {
  const source = readFileSync(new URL("./messageService.ts", import.meta.url), "utf8");
  assert.match(source, /surface: "direct_or_local",[\s\S]*?targetVisibleMentionedUserIds: mentionedUserIds,[\s\S]*?channelType: channel\.type,/);
  assert.match(source, /surface: "joint_channel",[\s\S]*?targetVisibleMentionedUserIds: mentionedUserIds,[\s\S]*?channelType: "joint",/);
  assert.match(source, /surface: "joint_thread",[\s\S]*?targetVisibleMentionedUserIds,[\s\S]*?channelType: "thread",/);
});

test("0183 backfills one canonical mode column and synchronizes rolling legacy writers", () => {
  const migration = readFileSync(
    new URL("../../drizzle/0183_brave_dragon_lord.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "server_push_mode" text DEFAULT 'all' NOT NULL/);
  assert.match(migration, /CASE WHEN "server_push_muted" THEN 'none' ELSE 'all' END/);
  assert.match(migration, /CHECK \("server_members"\."server_push_mode" IN \('all', 'mentions', 'none'\)\)/);
  assert.match(migration, /CREATE TRIGGER "server_members_push_mode_sync"/);
  assert.match(migration, /ELSIF NEW\."server_push_muted" IS DISTINCT FROM OLD\."server_push_muted"/);
  assert.doesNotMatch(migration, /server_push_mentions_only/);
});

test("0276 widens the push mode CHECK to include the pm_dm_mentions profile", () => {
  const migration = readFileSync(
    new URL("../../drizzle/0276_server_push_mode_pm_dm_mentions.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "server_members_server_push_mode_valid"/);
  assert.match(migration, /CHECK \("server_push_mode" IN \('all', 'mentions', 'none', 'pm_dm_mentions'\)\)/);
});
