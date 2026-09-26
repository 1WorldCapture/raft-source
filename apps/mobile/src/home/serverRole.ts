import { useSyncExternalStore } from "react";

let role: string | null = null;
const listeners = new Set<() => void>();

export function setCurrentServerRole(next: string | null) {
  if (role === next) return;
  role = next;
  for (const listener of listeners) listener();
}

export function useServerRole(): string | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => role);
}
