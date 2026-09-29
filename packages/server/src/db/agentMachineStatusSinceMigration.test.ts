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
const SERVER = "22222222-2222-4222-8222-222222222222";
const CHANGED = "33333333-3333-4333-8333-333333333333";
const NEVER_CHANGED = "44444444-4444-4444-8444-444444444444";
const MACHINE = "55555555-5555-4555-8555-555555555555";

test("0267 backfills agents.status_changed_at from the latest agent.status_changed event", async () => {
  const client = new PGlite();
  const before = await drizzleDirBefore(267);
  try {
    await client.exec(`SET TIME ZONE 'UTC'`);
    await migratePglite(client, before);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('${USER}', 'since@example.com', 'since', 'hash');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('${SERVER}', 'Since', 'since', '${USER}');
      INSERT INTO "daemons" ("id", "server_id", "user_id", "name", "api_key_hash", "last_heartbeat")
      VALUES ('${MACHINE}', '${SERVER}', '${USER}', 'box', 'hash', '2026-09-01T00:00:00.000Z');
      INSERT INTO "agents" ("id", "server_id", "name", "status", "created_at") VALUES
        ('${CHANGED}', '${SERVER}', 'changed', 'active', '2026-08-01T00:00:00.000Z'),
        ('${NEVER_CHANGED}', '${SERVER}', 'never', 'inactive', '2026-08-02T00:00:00.000Z');
      INSERT INTO "notification_events" ("id", "server_id", "event_type", "subject_type", "subject_id", "occurred_at") VALUES
        (gen_random_uuid(), '${SERVER}', 'agent.status_changed', 'agent', '${CHANGED}', '2026-08-10T00:00:00.000Z'),
        (gen_random_uuid(), '${SERVER}', 'agent.status_changed', 'agent', '${CHANGED}', '2026-08-20T00:00:00.000Z'),
        (gen_random_uuid(), '${SERVER}', 'agent.profile_updated', 'agent', '${CHANGED}', '2026-08-25T00:00:00.000Z'),
        (gen_random_uuid(), '${SERVER}', 'agent.status_changed', 'agent', '${CHANGED}', '2026-08-15T00:00:00.000Z');
    `);

    await migratePglite(client);

    const agents = await client.query<{ id: string; status_changed_at: Date | null }>(
      `SELECT "id", "status_changed_at" FROM "agents" ORDER BY "name"`,
    );
    const byId = new Map(agents.rows.map((row) => [row.id, row.status_changed_at?.toISOString() ?? null]));
    assert.equal(byId.get(CHANGED), "2026-08-20T00:00:00.000Z");
    assert.equal(byId.get(NEVER_CHANGED), "2026-08-02T00:00:00.000Z");

    // Machines carry no reliable since yet; readers fall back until the next transition.
    const machines = await client.query<{ last_status: string | null; status_changed_at: Date | null }>(
      `SELECT "last_status", "status_changed_at" FROM "daemons"`,
    );
    assert.deepEqual(machines.rows, [{ last_status: null, status_changed_at: null }]);

    // New agents default to their insert time.
    await client.exec(`INSERT INTO "agents" ("id", "server_id", "name") VALUES (gen_random_uuid(), '${SERVER}', 'fresh')`);
    const fresh = await client.query<{ status_changed_at: Date | null }>(
      `SELECT "status_changed_at" FROM "agents" WHERE "name" = 'fresh'`,
    );
    assert.ok(fresh.rows[0]?.status_changed_at instanceof Date);
  } finally {
    await client.close();
    await rm(before, { recursive: true, force: true });
  }
});
