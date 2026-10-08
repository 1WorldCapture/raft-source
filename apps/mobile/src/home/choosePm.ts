import { useSyncExternalStore } from "react";

// The header menu can reopen the PM picker after the owner skips setup.
// The PM tab reads this flag; other tabs only set it, then navigate to PM.
let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function requestChoosePm() {
  if (open) return;
  open = true;
  emit();
}

export function closeChoosePm() {
  if (!open) return;
  open = false;
  emit();
}

export function useChoosePm(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => open);
}
