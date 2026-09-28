// SQLite driver port for the local cache layer (client-data-cache task #1).
//
// The repository below speaks only to this interface. Two adapters exist:
//   - portExpo.ts  → expo-sqlite (runtime, React Native)
//   - portNode.ts  → node:sqlite  (unit tests only — real SQLite semantics
//                   under `node --import tsx --test`, so SQL behaviour is the
//                   same as on device)
//
// Reads are synchronous: they are local point lookups (sub-millisecond for
// the sizes involved) and cold-start first paint (task #2) needs them before
// an await boundary. ALL writes go through the async transaction API so the
// JS thread is never blocked by realtime write-through bursts (Firstmate
// review note #3).

export type SqliteValue = string | number | null;
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteDb {
  /** Execute raw SQL (DDL). No parameters. */
  exec(sql: string): void;
  /** Synchronous point read. Returns [] when no rows. */
  all(sql: string, params?: SqliteValue[]): SqliteRow[];
  /**
   * Synchronous single-statement write — BOOTSTRAP ONLY (schema setup,
   * scope open). All data writes must go through `write` so the JS thread
   * never blocks on realtime bursts (Firstmate review note #3).
   */
  run(sql: string, params?: SqliteValue[]): { changes: number };
  /** Async write inside a transaction. Rollback on throw. */
  write(fn: (tx: WriteTx) => Promise<void> | void): Promise<void>;
}

/** Statement handles valid only inside a `write` callback. */
export interface WriteTx {
  run(sql: string, params?: SqliteValue[]): { changes: number };
}

/** JSON helpers shared by the adapters and the repository. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function decodeJson<T>(raw: SqliteValue): T | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
