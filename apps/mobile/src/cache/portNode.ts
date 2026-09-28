// node:sqlite adapter for unit tests (test-only). Gives the repository real
// SQLite semantics under `node --import tsx --test`, matching device
// behaviour without pulling the native expo module into node.
//
// Transactions here are synchronous and single-threaded — exactly what the
// tests need; the repo never depends on interleaving.

import { DatabaseSync } from "node:sqlite";
import type { SqliteDb, SqliteRow, WriteTx } from "./port";

export function openNodeSqliteDb(path: string): SqliteDb {
  const db = new DatabaseSync(path);
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...(params ?? [])) as SqliteRow[],
    run: (sql, params) => {
      const result = db.prepare(sql).run(...(params ?? []));
      return { changes: Number(result?.changes ?? 0) };
    },
    write: async (fn) => {
      const tx: WriteTx = {
        run: (sql, params) => {
          const result = db.prepare(sql).run(...(params ?? []));
          return { changes: Number(result?.changes ?? 0) };
        },
      };
      db.exec("BEGIN");
      try {
        await fn(tx);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
