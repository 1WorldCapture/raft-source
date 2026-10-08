import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { StaleRequestError } from "../api/client";
import { useT } from "../i18n/provider";
import { useSession } from "../state/session";
import { pmLoadErrorMessage, SESSION_READY_WAIT_MS, shouldStopWaitingForSession } from "./pmLoad";
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
  const waitStartedRef = useRef<number | null>(null);
  const [waitAttempt, setWaitAttempt] = useState(0);
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
      setError(pmLoadErrorMessage(caught, tRef.current("mobile.pm.loadFailed")));
    } finally {
      if (slugRef.current === requested) setLoading(false);
    }
  }, [session.client, session.origin, session.ready, slug]);

  // A session that never becomes ready used to leave loading true forever,
  // because load() returns before it can clear that flag.
  useEffect(() => {
    if (!slug || (session.ready && session.origin)) {
      waitStartedRef.current = null;
      return;
    }
    if (waitStartedRef.current === null) waitStartedRef.current = Date.now();
    const elapsed = Date.now() - waitStartedRef.current;
    const remaining = Math.max(0, SESSION_READY_WAIT_MS - elapsed);
    const timer = setTimeout(() => {
      if (!shouldStopWaitingForSession(SESSION_READY_WAIT_MS, session.ready, Boolean(session.origin))) return;
      setLoading(false);
      setError(tRef.current("mobile.pm.loadFailed"));
    }, remaining);
    return () => clearTimeout(timer);
  }, [session.origin, session.ready, slug, waitAttempt]);

  const reload = useCallback(() => {
    waitStartedRef.current = Date.now();
    setWaitAttempt((attempt) => attempt + 1);
    setLoading(true);
    setError(null);
    return load();
  }, [load]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  return { state, loading, error, reload };
}
