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
  const slugRef = useRef(slug);
  slugRef.current = slug;
  const [trackedSlug, setTrackedSlug] = useState(slug);
  // Drop the previous server's PM before paint. Otherwise the new server
  // briefly shows that conversation while its own GET /pm is in flight.
  if (trackedSlug !== slug) {
    setTrackedSlug(slug);
    setState(null);
    setError(null);
    setLoading(Boolean(slug));
  }

  const load = useCallback(async () => {
    if (!session.ready || !session.origin) return;
    const requested = slug;
    if (!requested) {
      setState(null);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const data = await session.client.get<unknown>(`/servers/${encodeURIComponent(requested)}/pm`);
      if (slugRef.current !== requested) return;
      const parsed = parsePmTabState(data);
      if (!parsed) throw new Error("bad");
      setState(parsed);
    } catch (caught) {
      if (slugRef.current !== requested || caught instanceof StaleRequestError) return;
      setState(null);
      setError(caught instanceof ApiError ? caught.message : tRef.current("mobile.channels.loadFailed"));
    } finally {
      if (slugRef.current === requested) setLoading(false);
    }
  }, [session.client, session.origin, session.ready, slug]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  return { state, loading, error, reload: load };
}
