import { PGlite } from "@electric-sql/pglite";
import {
  closeDatabase,
  initDatabase,
  initPgliteDatabase,
  isDatabaseInitialized,
} from "../../db/index.js";
import { measureIntegrationPhase, ownIntegrationResource, poisonIntegrationEnvironment } from "./lifecycle.js";

// File-local immutable snapshot. Vitest retains file isolation; no cache is
// persisted between runs, so changed migrations/bootstrap always build afresh.
let template: Blob | null = null;
let opening = false;
let releaseDatabase: (() => void) | null = null;

export async function openTestDatabase(databaseUrl = "pglite://", searchDatabaseUrl?: string) {
  if (opening || isDatabaseInitialized()) {
    throw new Error("Close the current integration database before opening another");
  }
  opening = true;
  try {
    return await measureIntegrationPhase("database", async () => {
      // Real Postgres and persistent PGlite paths retain their original semantics.
      if (databaseUrl !== "pglite://" && databaseUrl !== "pglite://:memory:") {
        const db = await initDatabase(databaseUrl, searchDatabaseUrl);
        releaseDatabase = ownIntegrationResource(closeTestDatabase);
        return db;
      }
      const client = new PGlite(template ? { loadDataDir: template } : {});
      const db = await initPgliteDatabase(client);
      await patchTestSchemaForPendingMigrations(client);
      releaseDatabase = ownIntegrationResource(closeTestDatabase);
      if (!template) {
        try {
          template = await client.dumpDataDir("none");
        } catch (error) {
          await closeTestDatabase();
          throw error;
        }
      }
      return db;
    });
  } finally {
    opening = false;
  }
}

/**
 * Columns that ship in a migration still in flight on a feature branch
 * (Rethink UI phase A: migration 0275 adds servers.pm_agent_id and
 * servers.pm_setup_dismissed_at). The drizzle schema already references
 * pm_agent_id, so any unfiltered `select().from(servers)` in tests would
 * fail on a database built from committed migrations alone. Patching the
 * test database keeps those branches green; once 0275 merges this becomes
 * a no-op and can be deleted together with this comment.
 */
async function patchTestSchemaForPendingMigrations(client: PGlite) {
  await client.exec(`
    ALTER TABLE servers ADD COLUMN IF NOT EXISTS pm_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
    ALTER TABLE servers ADD COLUMN IF NOT EXISTS pm_setup_dismissed_at timestamptz;
  `);
}

export async function closeTestDatabase(): Promise<void> {
  try {
    if (isDatabaseInitialized()) {
      await measureIntegrationPhase("databaseClose", closeDatabase);
    }
  } catch (error) {
    poisonIntegrationEnvironment(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    releaseDatabase?.();
    releaseDatabase = null;
  }
}
