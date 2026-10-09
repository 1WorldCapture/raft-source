// Renderer side of the one-click migration (window.raftDesktop.migration; main: src/app/standalone/migration.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import type { MigrationActionId, MigrationState } from "./migrationLogic";

interface MigrationBridge {
  getState: () => Promise<unknown>;
  onState: (handler: (state: unknown) => void) => () => void;
  plan: () => Promise<unknown>;
  apply: () => Promise<unknown>;
  reset: () => Promise<unknown>;
}

function bridge(): MigrationBridge | null {
  return (globalThis as { raftDesktop?: { migration?: MigrationBridge } }).raftDesktop?.migration ?? null;
}

export function useMigration(): {
  state: MigrationState | null;
  /** Start the dry-run check (opens the dialog). */
  begin: () => Promise<void>;
  run: (action: MigrationActionId) => Promise<void>;
  error: string | null;
} {
  const [state, setState] = useState<MigrationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const b = bridge();
    if (!b) return () => { alive.current = false; };
    void b.getState().then((value) => { if (alive.current) setState(value as MigrationState); }).catch(() => undefined);
    const off = b.onState((value) => { if (alive.current) setState(value as MigrationState); });
    return () => { alive.current = false; off(); };
  }, []);

  const call = useCallback(async (fn: (b: MigrationBridge) => Promise<unknown>) => {
    const b = bridge();
    if (!b) return;
    setError(null);
    try {
      const next = await fn(b);
      if (alive.current) setState(next as MigrationState);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const begin = useCallback(() => call((b) => b.plan()), [call]);
  const run = useCallback(
    (action: MigrationActionId) => call((b) => (action === "apply" ? b.apply() : action === "recheck" ? b.plan() : b.reset())),
    [call],
  );
  return { state, begin, run, error };
}
