import { useSyncExternalStore } from "react";

let role: string | null = null;
let known = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function setCurrentServerRole(next: string | null) {
  if (role === next && known) return;
  role = next;
  known = true;
  emit();
}

export function resetCurrentServerRole() {
  if (role === null && !known) return;
  role = null;
  known = false;
  emit();
}

export function currentServerRoleSnapshot(): { role: string | null; known: boolean } {
  return { role, known };
}

export function useServerRole(): string | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => role);
}

export function useServerRoleKnown(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => known);
}
