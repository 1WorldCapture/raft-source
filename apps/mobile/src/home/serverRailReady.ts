import { useSyncExternalStore } from "react";

// False until the rail has been filled from cache or the first /servers
// response. The header uses this to show a spinner instead of the empty
// "Servers" title while the list is still unknown.
let resolved = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function markServerRailResolved() {
  if (resolved) return;
  resolved = true;
  emit();
}

export function resetServerRailResolved() {
  if (!resolved) return;
  resolved = false;
  emit();
}

export function useServerRailResolved(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => resolved);
}
