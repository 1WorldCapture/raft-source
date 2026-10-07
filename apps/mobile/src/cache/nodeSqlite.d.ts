// Minimal ambient types for the test-only node:sqlite adapter (portNode.ts).
// The app itself never imports node:sqlite — this keeps the adapter inside
// the regular typecheck without adding a @types/node dependency to the app.

declare module "node:sqlite" {
  export type StatementResult = {
    changes: number | bigint;
    lastInsertRowid: number | bigint | null;
  };
  export type Statement = {
    all(...params: Array<string | number | null | bigint | Uint8Array>): Array<Record<string, unknown>>;
    run(...params: Array<string | number | null | bigint | Uint8Array>): StatementResult;
  };
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
