import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migratePglite } from "./pgliteMigrations.js";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

/** A copy of the migration folder whose journal stops just before `idx`. */
async function drizzleDirBefore(idx: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "raft-drizzle-"));
  await cp(DRIZZLE_DIR, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx < idx);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

const USER = "11111111-1111-4111-8111-111111111111";
const SERVER_A = "22222222-2222-4222-8222-222222222222";
const SERVER_B = "33333333-3333-4333-8333-333333333333";
const SERVER_DELETED = "44444444-4444-4444-8444-444444444444";
const SERVER_JOINT_STORAGE = "55555555-5555-4555-8555-555555555555";
const USER_ANNOUNCEMENT = "66666666-6666-4666-8666-666666666666";

test("0268 tags #all, backfills one announcement channel per live server, and retires a same-named user channel", async () => {
  const client = new PGlite();
  const before = await drizzleDirBefore(268);
  try {
    await client.exec(`SET TIME ZONE 'UTC'`);
    await migratePglite(client, before);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('${USER}', 'ann@example.com', 'ann', 'hash');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id", "kind", "deleted_at") VALUES
        ('${SERVER_A}', 'A', 'a', '${USER}', 'normal', NULL),
        ('${SERVER_B}', 'B', 'b', '${USER}', 'normal', NULL),
        ('${SERVER_DELETED}', 'D', 'd', '${USER}', 'normal', now()),
        ('${SERVER_JOINT_STORAGE}', 'J', 'j', '${USER}', 'joint_storage', NULL);
      INSERT INTO "channels" ("id", "server_id", "name", "type") VALUES
        (gen_random_uuid(), '${SERVER_A}', 'all', 'channel'),
        (gen_random_uuid(), '${SERVER_B}', 'all', 'private');
      INSERT INTO "channels" ("id", "server_id", "name", "type") VALUES
        ('${USER_ANNOUNCEMENT}', '${SERVER_B}', 'announcement', 'channel');
    `);

    await migratePglite(client);

    const all = await client.query<{ server_id: string; system_kind: string | null }>(
      `SELECT "server_id", "system_kind" FROM "channels" WHERE "name" = 'all' ORDER BY "server_id"`,
    );
    assert.deepEqual(all.rows.map((row) => row.system_kind), ["all", "all"], "both #all (visible and hidden) are tagged");

    const announcement = await client.query<{ server_id: string; type: string }>(
      `SELECT "server_id", "type" FROM "channels"
       WHERE "system_kind" = 'announcement' AND "deleted_at" IS NULL ORDER BY "server_id"`,
    );
    assert.deepEqual(
      announcement.rows.map((row) => row.server_id),
      [SERVER_A, SERVER_B],
      "live normal servers only: not the deleted server, not the joint-storage server",
    );
    assert.ok(announcement.rows.every((row) => row.type === "channel"));

    const retired = await client.query<{ deleted_at: Date | null; system_kind: string | null }>(
      `SELECT "deleted_at", "system_kind" FROM "channels" WHERE "id" = '${USER_ANNOUNCEMENT}'`,
    );
    assert.ok(retired.rows[0]?.deleted_at instanceof Date, "the user's same-named channel is soft-deleted");
    assert.equal(retired.rows[0]?.system_kind, null);

    // One live announcement channel per server, enforced by the partial unique index.
    await assert.rejects(
      () => client.exec(`INSERT INTO "channels" ("id", "server_id", "name", "type", "system_kind")
        VALUES (gen_random_uuid(), '${SERVER_A}', 'announcement-2', 'channel', 'announcement')`),
    );

    const flag = await client.query<{ progress_announcements_enabled: boolean }>(
      `SELECT "progress_announcements_enabled" FROM "servers" WHERE "id" = '${SERVER_A}'`,
    );
    assert.equal(flag.rows[0]?.progress_announcements_enabled, false, "the feature is off by default");
  } finally {
    await client.close();
    await rm(before, { recursive: true, force: true });
  }
});
