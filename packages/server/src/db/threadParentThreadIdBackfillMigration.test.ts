import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// 0278 (upstream 1.21.2 port, their 0292 in generic form) repairs thread
// parents that getOrCreateThread left without thread_id before the stamp
// moved into the creation transaction. Only a NULL thread_id on the parent of
// a LIVE thread is filled; an existing stamp is never overwritten and deleted
// threads are not stamped. Idempotent.
const migrationPath = new URL("../../drizzle/0278_backfill_thread_parent_thread_id.sql", import.meta.url);

test("0278 fills only NULL thread_id on parents of live threads", async () => {
  const migration = await readFile(migrationPath, "utf8");
  assert.doesNotMatch(migration.replace(/^\s*--.*$/gm, ""), /\bDELETE\b|\bTRUNCATE\b|\bALTER\b|\bDROP\b/i);

  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE messages (id uuid PRIMARY KEY, thread_id text);
      CREATE TABLE channels (id uuid PRIMARY KEY, parent_message_id uuid, type text NOT NULL, deleted_at timestamptz);
    `);
    const seed = async (id: string, threadId: string | null) => {
      await db.query(`INSERT INTO messages (id, thread_id) VALUES ($1, $2)`, [id, threadId]);
    };
    const seedThread = async (id: string, parentId: string, deleted = false) => {
      await db.query(
        `INSERT INTO channels (id, parent_message_id, type, deleted_at) VALUES ($1, $2, 'thread', $3)`,
        [id, parentId, deleted ? new Date() : null],
      );
    };

    // Broken pair: live thread pointing at a parent with a NULL stamp.
    await seed("00000000-0000-4000-8000-0000000000b1", null);
    await seedThread("00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b1");
    // Already stamped: never overwritten.
    await seed("00000000-0000-4000-8000-0000000000b2", "11111111-1111-4111-8111-111111111111");
    await seedThread("00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000b2");
    // Deleted thread: parent stays NULL.
    await seed("00000000-0000-4000-8000-0000000000b3", null);
    await seedThread("00000000-0000-4000-8000-0000000000a3", "00000000-0000-4000-8000-0000000000b3", true);
    // No thread at all: untouched.
    await seed("00000000-0000-4000-8000-0000000000b4", null);

    await db.exec(migration);
    const threadIdOf = async (id: string) =>
      (await db.query<{ thread_id: string | null }>(`SELECT thread_id FROM messages WHERE id = $1`, [id])).rows[0]?.thread_id ?? null;

    assert.equal(await threadIdOf("00000000-0000-4000-8000-0000000000b1"), "00000000-0000-4000-8000-0000000000a1", "the broken pair is stamped");
    assert.equal(await threadIdOf("00000000-0000-4000-8000-0000000000b2"), "11111111-1111-4111-8111-111111111111", "an existing stamp is never overwritten");
    assert.equal(await threadIdOf("00000000-0000-4000-8000-0000000000b3"), null, "a deleted thread is not stamped");
    assert.equal(await threadIdOf("00000000-0000-4000-8000-0000000000b4"), null, "a parent with no thread stays NULL");

    // Idempotent: a second run changes nothing.
    await db.exec(migration);
    assert.equal(await threadIdOf("00000000-0000-4000-8000-0000000000b1"), "00000000-0000-4000-8000-0000000000a1");
  } finally {
    await db.close();
  }
});
