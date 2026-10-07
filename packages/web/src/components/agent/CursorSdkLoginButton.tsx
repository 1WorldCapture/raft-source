// Web entry for the Cursor SDK owner sign-in (Cursor SDK 修复-1).
//
// Owner-only upstream: the server rejects non-owners (and agents) with 403,
// so the button simply renders the error when that happens. Flow:
//   status check (bound → explicit replace confirm)
//   → POST login → re-validate the URL here (https, cursor.com)
//   → open it → poll the sanitized status until the binding flips to "bound"
//   → onBound() (the dialog rescans the model list).
// A pending sign-in returns the SAME URL (daemon-side single flight); the
// authorization wait is capped by POLL_TIMEOUT_MS.

import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "raft-ui";
import api from "../../api/client";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

type Phase = "idle" | "starting" | "awaiting_browser";

interface CursorSdkLoginButtonProps {
  serverId: string;
  machineId: string;
  /** Called once the binding is observed as "bound" — refresh the model list. */
  onBound: () => void;
  /** Test seam: shrink the status polling interval. */
  pollIntervalMs?: number;
}

/** Same shape the daemon validates; the web re-checks before opening. */
function isCursorLoginUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "cursor.com"
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

export default function CursorSdkLoginButton({ serverId, machineId, onBound, pollIntervalMs = POLL_INTERVAL_MS }: CursorSdkLoginButtonProps) {
  const intl = useIntl();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => () => {
    cancelledRef.current = true;
    if (pollTimerRef.current !== null) window.clearInterval(pollTimerRef.current);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const beginLogin = useCallback(async () => {
    if (phase !== "idle") return;
    setError(null);
    setLoginUrl(null);
    setPhase("starting");
    try {
      // Signing in again rebinds this machine — an already-bound Computer must
      // confirm the replacement before anything is sent to the daemon.
      const before = await api.get(`/servers/${serverId}/machines/${machineId}/cursor-sdk/status`);
      const currentStatus = (before.data as { status?: string } | undefined)?.status;
      if (currentStatus === "bound" || currentStatus === "bound_stale_key") {
        if (!window.confirm(intl.formatMessage({ id: "agent.runtimeModels.cursorReplaceConfirm" }))) {
          setPhase("idle");
          return;
        }
      }
      const started = await api.post(`/servers/${serverId}/machines/${machineId}/cursor-sdk/login`);
      const data = (started.data ?? {}) as { ok?: boolean; loginUrl?: string; message?: string };
      if (!data.ok || !isCursorLoginUrl(data.loginUrl)) {
        setError(data.message ?? intl.formatMessage({ id: "agent.runtimeModels.cursorLoginFailed" }));
        setPhase("idle");
        return;
      }
      setLoginUrl(data.loginUrl);
      // A window.open issued AFTER awaits may be treated as a non-user-gesture
      // popup and swallowed before it ever reaches the desktop shell — so the
      // authorization link is ALSO rendered below as a clickable/copyable
      // fallback (see loginUrl state). Attempt the automatic open as a
      // convenience only.
      window.open(data.loginUrl, "_blank", "noopener,noreferrer");
      setPhase("awaiting_browser");
      const startedAtMs = Date.now();
      pollTimerRef.current = window.setInterval(async () => {
        if (cancelledRef.current) return;
        if (Date.now() - startedAtMs > POLL_TIMEOUT_MS) {
          stopPolling();
          setError(intl.formatMessage({ id: "agent.runtimeModels.cursorLoginTimeout" }));
          setPhase("idle");
          return;
        }
        try {
          const polled = await api.get(`/servers/${serverId}/machines/${machineId}/cursor-sdk/status`);
          if ((polled.data as { status?: string } | undefined)?.status === "bound") {
            stopPolling();
            setPhase("idle");
            onBound();
          }
          // "disconnected" and transient failures keep polling — the user may
          // still be in the middle of the browser authorization.
        } catch {
          // Transient (network/refresh) — the next tick retries.
        }
      }, pollIntervalMs);
    } catch (err) {
      const axiosError = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
      setError(
        axiosError?.response?.data?.error
          ?? axiosError?.response?.data?.message
          ?? axiosError?.message
          ?? intl.formatMessage({ id: "agent.runtimeModels.cursorLoginFailed" }),
      );
      setPhase("idle");
    }
  }, [phase, serverId, machineId, intl, onBound, stopPolling]);

  const busy = phase !== "idle";
  return (
    <>
      <Button
        variant="link"
        size="inline"
        type="button"
        onClick={beginLogin}
        disabled={busy}
        data-testid="cursor-sdk-login-button"
      >
        {phase === "starting"
          ? intl.formatMessage({ id: "agent.runtimeModels.cursorLoginStarting" })
          : phase === "awaiting_browser"
            ? intl.formatMessage({ id: "agent.runtimeModels.cursorLoginWaiting" })
            : intl.formatMessage({ id: "agent.runtimeModels.cursorLoginButton" })}
      </Button>
      {loginUrl && phase === "awaiting_browser" ? (
        <span className="ml-1 break-all">
          {" "}
          <a
            href={loginUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
            data-testid="cursor-sdk-login-link"
          >
            {intl.formatMessage({ id: "agent.runtimeModels.cursorLoginOpenLink" })}
          </a>
          {" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => { void navigator.clipboard?.writeText(loginUrl); }}
            data-testid="cursor-sdk-login-copy"
          >
            {intl.formatMessage({ id: "agent.runtimeModels.cursorLoginCopy" })}
          </button>
        </span>
      ) : null}
      {error ? <span className="text-red-600">{" "}{error}</span> : null}
    </>
  );
}
