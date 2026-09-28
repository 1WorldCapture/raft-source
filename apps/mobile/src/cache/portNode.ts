// node:sqlite adapter for unit tests (test-only). Gives the repository real
// SQLite semantics under `node --import tsx --test`, matching device
// behaviour without pulling the native expo module into node.
//
// Statements inside `write` are async on the interface (the expo adapter
// needs them off the JS thread) but execute synchronously here — node is
// single-threaded per test and the repo never depends on interleaving.

import { DatabaseSync } from "node:sqlite";
import type { SqliteDb, SqliteRow, SqliteValue, WriteTx } from "./port";

export function openNodeSqliteDb(path: string): SqliteDb {
  const db = new DatabaseSync(path);
  const syncRun = (sql: string, params?: SqliteValue[]) => {
    const result = db.prepare(sql).run(...(params ?? []));
    return { changes: Number(result?.changes ?? 0) };
  };
  // Serialized write queue: a second write() call while one transaction is
  // still awaiting its body would otherwise BEGIN inside the open
  // transaction ("cannot start a transaction within a transaction"). This
  // mirrors the queue the repo needs regardless of adapter.
  let writeChain: Promise<void> = Promise.resolve();
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, params) => db.prepare(sql).all(...(params ?? [])) as SqliteRow[],
    run: syncRun,
    write: (fn: (tx: WriteTx) => Promise<void>) => {
      const run = writeChain.then(async () => {
        const tx: WriteTx = {
          run: async (sql, params) => syncRun(sql, params),
        };
        db.exec("BEGIN");
        try {
          await fn(tx);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      writeChain = run.catch(() => {});
      return run;
    },
  };
}
