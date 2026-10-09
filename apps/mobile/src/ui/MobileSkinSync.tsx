import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { createSkinSync } from "@botiverse/raft-shared/src/skinSync.ts";
import { isSkinId } from "@botiverse/raft-shared/src/skins.ts";
import { useOfflineStore } from "../cache/cacheCleanup";
import { useSession } from "../state/session";
import { adoptSkin, explicitSkinId, getSkinId, getSkinPending, onUserSkinChange, setSkinPending } from "./skin";
import "./skinPersistence";

/**
 * Keeps the phone skin aligned with the account. Renders nothing.
 * First paint stays on the local file; this runs only after /auth/me (or login)
 * has said what the account stores.
 */
export function MobileSkinSync() {
  const session = useSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const userId = session.user?.id ?? null;
  const serverSkin = session.user?.preferredSkin;
  const offline = useOfflineStore((state) => state.offline);

  const sync = useMemo(() => createSkinSync({
    storage: { getPending: getSkinPending, setPending: setSkinPending },
    isKnown: isSkinId,
    localExplicit: explicitSkinId,
    current: getSkinId,
    adopt: adoptSkin,
    push: async (id) => {
      if (useOfflineStore.getState().offline) throw new Error("offline");
      if (!sessionRef.current.user) throw new Error("signed out");
      await sessionRef.current.updateProfile({ preferredSkin: id });
    },
  }), []);

  const reconciledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || !session.profileSynced) {
      if (!userId) reconciledFor.current = null;
      return;
    }
    if (serverSkin === undefined) return;
    if (reconciledFor.current === userId) return;
    reconciledFor.current = userId;
    void sync.onLogin(serverSkin);
  }, [serverSkin, session.profileSynced, sync, userId]);

  useEffect(() => {
    if (userId && session.profileSynced && reconciledFor.current === userId) sync.onServerValue(serverSkin);
  }, [serverSkin, session.profileSynced, sync, userId]);

  useEffect(() => onUserSkinChange((id) => {
    if (sessionRef.current.user) void sync.onUserPick(id);
  }), [sync]);

  const wasOffline = useRef(offline);
  useEffect(() => {
    const cameBack = wasOffline.current && !offline;
    wasOffline.current = offline;
    if (cameBack) flushPendingOrRefresh();
  }, [offline, sync]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") flushPendingOrRefresh();
    });
    return () => subscription.remove();
  }, [sync]);

  function flushPendingOrRefresh() {
    if (!sessionRef.current.user) return;
    if (getSkinPending()) {
      void sync.onOnline();
      return;
    }
    void sessionRef.current.refreshAccount().catch(() => {});
  }

  return null;
}
