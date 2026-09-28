// expo-sqlite adapter for the cache layer's SqliteDb port (runtime only).
// Unit tests use portNode.ts instead — nothing but repo.ts's runtime entry
// point imports this file.

import * as ExpoSQLite from "expo-sqlite";
import type { SqliteDb, SqliteRow, WriteTx } from "./port";

export function openExpoSqliteDb(name: string): SqliteDb {
  const db = ExpoSQLite.openDatabaseSync(name);
  const bind = (params?: Array<string | number | null>) => params ?? [];
  return {
    exec: (sql) => db.execSync(sql),
    all: (sql, params) => db.getAllSync(sql, bind(params)) as SqliteRow[],
    run: (sql, params) => {
      const result = db.runSync(sql, bind(params));
      return { changes: result?.changes ?? 0 };
    },
    write: (fn) =>
      db.withTransactionAsync(async () => {
        const tx: WriteTx = {
          run: (sql, params) => {
            const result = db.runSync(sql, bind(params));
            return { changes: result?.changes ?? 0 };
          },
        };
        await fn(tx);
      }),
  };
}
