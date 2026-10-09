import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { StaleRequestError } from "../api/client";
import { getCacheRuntime } from "../cache/runtime";
import { useT } from "../i18n/provider";
import { useSession } from "../state/session";
import { pmLoadErrorMessage, SESSION_READY_WAIT_MS, shouldStopWaitingForSession } from "./pmLoad";
import { parsePmTabState, PM_TAB_CACHE_KEY, pmTabCacheRecord, type PmTabState } from "./pmState";

function readCachedPmTab(origin: string, userId: string, serverId: string): PmTabState | null {
  try {
    const runtime = getCacheRuntime();
    if (runtime.scopeId === null) runtime.attach(origin, userId, serverId);
    const scope = runtime.scopeFor(serverId);
    if (scope === null) return null;
    return parsePmTabState(runtime.repo.getKvSync(scope, PM_TAB_CACHE_KEY));
  } catch {
    return null;
  }
}

function persistPmTab(serverId: string, parsed: PmTabState) {
  void (async () => {
    try {
      const runtime = getCacheRuntime();
      const scope = runtime.scopeFor(serverId);
      if (scope === null) return;
      await runtime.repo.putKv(scope, PM_TAB_CACHE_KEY, pmTabCacheRecord(parsed));
    } catch {
      // The screen still works from the network.
    }
  })();
}

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
  const serverId = session.serverId;
  const cacheKey = session.ready && session.origin && session.user ? `${serverId ?? ""}:${slug ?? ""}` : null;
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  // Paint the cached PM before the network, including the first frame.
  // A missing slug is still unknown: leave the spinner up instead of the
  // "waiting for an admin" empty state.
  if (cacheKey !== null && appliedKey !== cacheKey) {
    setAppliedKey(cacheKey);
    setError(null);
    if (!slug || !serverId || !session.origin || !session.user) {
      setState(null);
      setLoading(true);
    } else {
      const cached = readCachedPmTab(session.origin, session.user.id, serverId);
      setState(cached);
      setLoading(cached === null);
    }
  }

  const load = useCallback(async () => {
    if (!session.ready || !session.origin) return;
    const requested = slug;
    if (!requested) return;
    setError(null);
    try {
      const data = await session.client.get<unknown>(`/servers/${encodeURIComponent(requested)}/pm`);
      if (slugRef.current !== requested) return;
      const parsed = parsePmTabState(data);
      if (!parsed) throw new Error("bad");
      setState(parsed);
      if (session.serverId) persistPmTab(session.serverId, parsed);
    } catch (caught) {
      if (slugRef.current !== requested || caught instanceof StaleRequestError) return;
      setError(pmLoadErrorMessage(caught, tRef.current("mobile.pm.loadFailed")));
    } finally {
      if (slugRef.current === requested) setLoading(false);
    }
  }, [session.client, session.origin, session.ready, session.serverId, slug]);

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
