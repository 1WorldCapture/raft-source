// Renderer side of the standalone Computer (window.raftDesktop.standalone; main: src/app/standalone/ipc.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import type { StandaloneActionId, StandaloneState } from "./standaloneCardLogic";

type HostMode = { mode: "embedded" } | { mode: "standalone"; home: string };

interface StandaloneBridge {
  hostMode: () => Promise<HostMode>;
  getState: () => Promise<unknown>;
  onState: (handler: (state: unknown) => void) => () => void;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  install: () => Promise<unknown>;
  upgrade: () => Promise<unknown>;
}

function bridge(): StandaloneBridge | null {
  return (globalThis as { raftDesktop?: { standalone?: StandaloneBridge } }).raftDesktop?.standalone ?? null;
}

/** null while unknown (and always null on web / builds without the bridge); resolves once per mount. */
export function useHostMode(): HostMode | null {
  const [mode, setMode] = useState<HostMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    const b = bridge();
    if (!b) return;
    void b.hostMode().then((value) => { if (!cancelled) setMode(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return mode;
}

export function useStandaloneComputer(): {
  state: StandaloneState | null;
  busy: StandaloneActionId | null;
  error: string | null;
  run: (action: StandaloneActionId) => Promise<void>;
} {
  const [state, setState] = useState<StandaloneState | null>(null);
  const [busy, setBusy] = useState<StandaloneActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const b = bridge();
    if (!b) return () => { alive.current = false; };
    void b.getState().then((value) => { if (alive.current) setState(value as StandaloneState); }).catch((e: unknown) => setError(String(e)));
    const off = b.onState((value) => { if (alive.current) setState(value as StandaloneState); });
    return () => { alive.current = false; off(); };
  }, []);

  const run = useCallback(async (action: StandaloneActionId) => {
    const b = bridge();
    if (!b) return;
    setBusy(action);
    setError(null);
    try {
      const result = action === "start" ? await b.start()
        : action === "stop" ? await b.stop()
        : action === "install" ? await b.install()
        : action === "upgrade" ? await b.upgrade()
        : await b.getState();
      // start/stop return the refreshed state; install/upgrade are followed by the poll, so re-read.
      const next = action === "start" || action === "stop" || action === "refresh" ? result : await b.getState();
      if (alive.current) setState(next as StandaloneState);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, []);

  return { state, busy, error, run };
}
