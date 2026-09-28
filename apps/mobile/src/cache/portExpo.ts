// expo-sqlite adapter for the cache layer's SqliteDb port (runtime only).
// Unit tests use portNode.ts instead — nothing but repo.ts's runtime entry
// point imports this file.
//
// Writes use withExclusiveTransactionAsync + runAsync: exclusive (no other
// statement folds into the transaction) and fully async — never the JS-thread
// synchronous path (Firstmate review follow-up).

import * as ExpoSQLite from "expo-sqlite";
import type { SqliteDb, SqliteRow, WriteTx } from "./port";

export function openExpoSqliteDb(name: string): SqliteDb {
  const db = ExpoSQLite.openDatabaseSync(name);
  const bind = (params?: Array<string | number | null>) => params ?? [];
  // Serialized write queue on top of the exclusive transaction: repo callers
  // may fire writes without awaiting the previous one (home directory
  // persist + reconcile), and the queue keeps every transaction standalone
  // instead of racing into a nested BEGIN.
  let writeChain: Promise<unknown> = Promise.resolve();
  return {
    exec: (sql) => db.execSync(sql),
    all: (sql, params) => db.getAllSync(sql, bind(params)) as SqliteRow[],
    run: (sql, params) => {
      const result = db.runSync(sql, bind(params));
      return { changes: result?.changes ?? 0 };
    },
    write: (fn) => {
      const run = writeChain.then(() =>
        db.withExclusiveTransactionAsync(async (txn) => {
          const tx: WriteTx = {
            run: async (sql, params) => {
              const result = await txn.runAsync(sql, bind(params));
              return { changes: result?.changes ?? 0 };
            },
          };
          await fn(tx);
        }),
      );
      writeChain = run.catch(() => {});
      return run as Promise<void>;
    },
  };
}
