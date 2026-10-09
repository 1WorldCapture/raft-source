import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migratePglite } from "./pgliteMigrations.js";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const USER = "11111111-1111-4111-8111-111111111111";
const OLD_USER = "66666666-6666-4666-8666-666666666666";

async function migrationStatements(): Promise<string[]> {
  const sql = await readFile(path.join(DRIZZLE_DIR, "0277_user_preferred_skin.sql"), "utf8");
  return sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

test("0277 adds a nullable users.preferred_skin; empty db, db with existing users, and a second run all work", async () => {
  const client = new PGlite();
  try {
    await migratePglite(client, DRIZZLE_DIR); // empty database path
    const column = await client.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'preferred_skin'`,
    );
    assert.deepEqual(column.rows, [{ is_nullable: "YES", data_type: "text" }]);

    // Database that already has users when the migration runs: drop the column, insert, re-run.
    await client.exec(`ALTER TABLE "users" DROP COLUMN "preferred_skin"`);
    await client.exec(`INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${OLD_USER}', 'old@example.com', 'old', 'hash')`);
    for (const statement of await migrationStatements()) await client.exec(statement);
    // Repeatable: running it again changes nothing and does not fail.
    for (const statement of await migrationStatements()) await client.exec(statement);

    const old = await client.query<{ preferred_skin: string | null }>(`SELECT preferred_skin FROM users WHERE id = '${OLD_USER}'`);
    assert.deepEqual(old.rows, [{ preferred_skin: null }], "existing users start with no preference");

    await client.exec(`INSERT INTO "users" ("id", "email", "name", "password_hash", "preferred_skin") VALUES ('${USER}', 'new@example.com', 'new', 'hash', 'rose')`);
    const row = await client.query<{ preferred_skin: string | null }>(`SELECT preferred_skin FROM users WHERE id = '${USER}'`);
    assert.equal(row.rows[0]?.preferred_skin, "rose");
  } finally {
    await client.close();
  }
}, 120_000);
