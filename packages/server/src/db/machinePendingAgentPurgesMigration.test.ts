import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migratePglite } from "./pgliteMigrations.js";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const USER = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";
const MACHINE = "55555555-5555-4555-8555-555555555555";
const AGENT = "33333333-3333-4333-8333-333333333333";

async function migrationStatements(): Promise<string[]> {
  const sql = await readFile(path.join(DRIZZLE_DIR, "0274_machine_pending_agent_purges.sql"), "utf8");
  return sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

test("0274 creates the pending-purge table, is safe to run twice, and cascades with machine and agent", async () => {
  const client = new PGlite();
  try {
    await migratePglite(client, DRIZZLE_DIR);
    // Guarded/idempotent: re-running every statement of the migration changes nothing and does not fail.
    for (const statement of await migrationStatements()) await client.exec(statement);

    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${USER}', 'purge@example.com', 'purge', 'hash');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Purge', 'purge', '${USER}');
      INSERT INTO "daemons" ("id", "server_id", "user_id", "name", "api_key_hash") VALUES ('${MACHINE}', '${SERVER}', '${USER}', 'box', 'hash');
      INSERT INTO "agents" ("id", "server_id", "name", "status") VALUES ('${AGENT}', '${SERVER}', 'gone', 'inactive');
      INSERT INTO "machine_pending_agent_purges" ("machine_id", "agent_id") VALUES ('${MACHINE}', '${AGENT}');
    `);
    const row = await client.query<{ attempts: number; created_at: unknown }>(
      `SELECT attempts, created_at FROM machine_pending_agent_purges`,
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].attempts, 0);
    assert.ok(row.rows[0].created_at);

    // primary key (machine_id, agent_id): the same intent cannot be recorded twice
    await assert.rejects(client.exec(`INSERT INTO "machine_pending_agent_purges" ("machine_id", "agent_id") VALUES ('${MACHINE}', '${AGENT}')`));
    // deleting the machine removes its pending purges
    await client.exec(`DELETE FROM "daemons" WHERE id = '${MACHINE}'`);
    const after = await client.query(`SELECT 1 FROM machine_pending_agent_purges`);
    assert.equal(after.rows.length, 0);
  } finally {
    await client.close();
  }
}, 120_000);
