import { useEffect, useMemo, useRef } from "react";
import { useAuthStore } from "@web/store/authStore";
import { SKINS, adoptSyncedSkin, currentSkinId, explicitSkinId, onUserSkinChange } from "./skins";
import { createSkinSync } from "@botiverse/raft-shared/src/skinSync.ts";

const PENDING_KEY = "raft-desktop-skin-pending";

const storage = {
  getPending(): boolean {
    try {
      return localStorage.getItem(PENDING_KEY) === "1";
    } catch {
      return false;
    }
  },
  setPending(value: boolean): void {
    try {
      if (value) localStorage.setItem(PENDING_KEY, "1");
      else localStorage.removeItem(PENDING_KEY);
    } catch {
      // Non-fatal.
    }
  },
};

/**
 * Keeps the desktop skin in sync with the account's `preferredSkin` (renders
 * nothing). Logic lives in skinSync.ts; this only wires it to the auth store,
 * the switcher's user picks and the `online` event.
 */
export function DesktopSkinSync() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const serverSkin = useAuthStore((s) => s.user?.preferredSkin ?? null);
  const sync = useMemo(() => createSkinSync({
    storage,
    isKnown: (id) => SKINS.some((skin) => skin.id === id),
    localExplicit: explicitSkinId,
    current: currentSkinId,
    adopt: adoptSyncedSkin,
    push: (id) => useAuthStore.getState().updateProfile({ preferredSkin: id }),
  }), []);

  const reconciledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!userId) {
      reconciledFor.current = null;
      return;
    }
    if (reconciledFor.current === userId) return;
    reconciledFor.current = userId;
    void sync.onLogin(useAuthStore.getState().user?.preferredSkin ?? null);
  }, [sync, userId]);

  // Later changes of the account value (another device, refreshed profile).
  useEffect(() => {
    if (userId && reconciledFor.current === userId) sync.onServerValue(serverSkin);
  }, [serverSkin, sync, userId]);

  useEffect(() => onUserSkinChange((id) => { if (useAuthStore.getState().user) void sync.onUserPick(id); }), [sync]);
  useEffect(() => {
    const online = () => { if (useAuthStore.getState().user) void sync.onOnline(); };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [sync]);

  return null;
}
