// Server-address settings for the desktop (private deployment phase 3-1).
//
// The deployment origin is boot-scoped: a saved change takes effect at
// relaunch (main bumps the environment generation so the renderer clears
// auth state — switching servers is intentionally a full sign-out). This
// dialog is the only user surface for it; it renders ONLY when the native
// bridge exposes the serverOrigin API (new preloads — old builds hide the
// entry entirely).
//
// Input handling note (PM review): runtime origins are https-only because
// the bundled renderer's stock CSP allows just https/wss connect targets.
// A bare host is auto-prefixed with https:// for convenience, but an
// explicit http:// input is refused with an explanation + the build-time
// alternative instead of silently upgrading it.

import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import Modal from "@web/components/Modal";
import ConfirmDialog from "@web/components/ConfirmDialog";
import Banner from "@web/components/ui/Banner";
import Button from "@web/components/ui/Button";

export interface ServerOriginStatusBridge {
  origin: string;
  override: string | null;
  bakedOrigin: string;
  isOfficial: boolean;
  generation: number;
}

export interface ServerOriginSetResult {
  ok: boolean;
  changed?: boolean;
  generation?: number;
  error?: string;
}

interface ServerOriginBridge {
  get(): Promise<ServerOriginStatusBridge>;
  set(origin: string): Promise<ServerOriginSetResult>;
  reset(): Promise<ServerOriginSetResult>;
  relaunch(): void;
}

export function getServerOriginBridge(): ServerOriginBridge | null {
  return (globalThis as { raftDesktop?: { serverOrigin?: ServerOriginBridge } }).raftDesktop?.serverOrigin ?? null;
}

/** True when this build exposes the server-origin settings surface. */
export function serverOriginSettingsAvailable(): boolean {
  return getServerOriginBridge() !== null;
}

// Mirror of the main-process validator (display-side only; main re-validates):
// https origin, root path, no credentials/query/hash.
function validateOriginInput(raw: string): { kind: "ok"; origin: string } | { kind: "http" } | { kind: "invalid" } {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "invalid" };
  // Convenience: a bare "host[:port]" means https.
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { kind: "invalid" };
  }
  if (url.protocol === "http:") return { kind: "http" };
  if (url.protocol !== "https:") return { kind: "invalid" };
  if (url.username || url.password || url.search || url.hash) return { kind: "invalid" };
  if (url.pathname !== "/" && url.pathname !== "") return { kind: "invalid" };
  if (url.origin !== candidate) return { kind: "invalid" };
  return { kind: "ok", origin: url.origin };
}

export function ServerOriginDialog({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const bridge = getServerOriginBridge();
  const [status, setStatus] = useState<ServerOriginStatusBridge | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "set" | "reset">(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge.get().then(setStatus).catch(() => setStatus(null));
  }, [bridge]);

  const validation = useMemo(() => (input.trim() === "" ? null : validateOriginInput(input)), [input]);

  if (!bridge) return null;

  const currentOrigin = status?.origin ?? "";
  const dirty = validation?.kind === "ok" && validation.origin !== currentOrigin;

  const handleSet = async () => {
    if (validation?.kind !== "ok") return;
    setError(null);
    try {
      const result = await bridge.set(validation.origin);
      if (!result.ok) {
        setError(formatMessage({ id: "desktop.serverOrigin.error" }));
        return;
      }
      bridge.relaunch(); // saved — apply now (change is boot-scoped)
    } catch {
      setError(formatMessage({ id: "desktop.serverOrigin.error" }));
    }
  };

  const handleReset = async () => {
    setError(null);
    try {
      const result = await bridge.reset();
      if (!result.ok) {
        setError(formatMessage({ id: "desktop.serverOrigin.error" }));
        return;
      }
      bridge.relaunch();
    } catch {
      setError(formatMessage({ id: "desktop.serverOrigin.error" }));
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="w-[420px] border-2 border-black bg-white p-5 shadow-brutal">
        <h2 className="font-display text-lg font-bold">
          {formatMessage({ id: "desktop.serverOrigin.title" })}
        </h2>

        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-neutral-500">
              {formatMessage({ id: "desktop.serverOrigin.currentOrigin" })}
            </dt>
            <dd className="truncate font-medium">{currentOrigin || "…"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-neutral-500">
              {formatMessage({ id: "desktop.serverOrigin.bakedOrigin" })}
            </dt>
            <dd className="truncate font-medium">{status?.bakedOrigin ?? "…"}</dd>
          </div>
        </dl>
        {status?.override ? (
          <div className="mt-2">
            <Banner intent="info">
              {formatMessage({ id: "desktop.serverOrigin.overrideActive" })}
            </Banner>
          </div>
        ) : null}

        <label className="mt-4 block text-sm font-medium" htmlFor="raft-server-origin-input">
          {formatMessage({ id: "desktop.serverOrigin.inputLabel" })}
        </label>
        <input
          id="raft-server-origin-input"
          className="mt-1 w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none focus:shadow-brutal-sm"
          placeholder={formatMessage({ id: "desktop.serverOrigin.inputPlaceholder" })}
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => { setInput(e.target.value); setError(null); }}
        />
        {validation?.kind === "http" ? (
          <div className="mt-2">
            <Banner intent="warning">
              {formatMessage({ id: "desktop.serverOrigin.invalidHttp" })}
            </Banner>
          </div>
        ) : validation?.kind === "invalid" ? (
          <div className="mt-2">
            <Banner intent="destructive">
              {formatMessage({ id: "desktop.serverOrigin.invalid" })}
            </Banner>
          </div>
        ) : null}
        {error ? (
          <div className="mt-2">
            <Banner intent="destructive">{error}</Banner>
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            type="button"
            className="text-sm text-neutral-500 underline-offset-2 hover:underline disabled:opacity-40"
            disabled={!status?.override}
            onClick={() => setConfirming("reset")}
          >
            {formatMessage({ id: "desktop.serverOrigin.reset" })}
          </button>
          <div className="flex items-center gap-2">
            <Button tone="white" onClick={onClose}>✕</Button>
            <Button
              tone="yellow"
              disabled={!dirty}
              onClick={() => setConfirming("set")}
            >
              {formatMessage({ id: "desktop.serverOrigin.apply" })}
            </Button>
          </div>
        </div>
      </div>

      {confirming === "set" ? (
        <ConfirmDialog
          layer={1}
          title={formatMessage({ id: "desktop.serverOrigin.confirmTitle" })}
          message={formatMessage({ id: "desktop.serverOrigin.confirmBody" })}
          confirmLabel={formatMessage({ id: "desktop.serverOrigin.apply" })}
          onConfirm={() => { setConfirming(null); void handleSet(); }}
          onClose={() => setConfirming(null)}
        />
      ) : null}
      {confirming === "reset" ? (
        <ConfirmDialog
          layer={1}
          title={formatMessage({ id: "desktop.serverOrigin.resetConfirm" })}
          message={formatMessage({ id: "desktop.serverOrigin.confirmBody" })}
          confirmLabel={formatMessage({ id: "desktop.serverOrigin.reset" })}
          onConfirm={() => { setConfirming(null); void handleReset(); }}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </Modal>
  );
}
