import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { ApiError, StaleRequestError } from "../api/client";
import { useT } from "../i18n/provider";
import { useSession } from "../state/session";
import { parsePmTabState, type PmTabState } from "./pmState";

export function useServerPm(slug: string | null) {
  const session = useSession();
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, setState] = useState<PmTabState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!slug) {
      setState(null);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const data = await session.client.get<unknown>(`/servers/${encodeURIComponent(slug)}/pm`);
      const parsed = parsePmTabState(data);
      if (!parsed) throw new Error("bad");
      setState(parsed);
    } catch (caught) {
      if (caught instanceof StaleRequestError) return;
      setState(null);
      setError(caught instanceof ApiError ? caught.message : tRef.current("mobile.channels.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [session.client, slug]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  return { state, loading, error, reload: load };
}
