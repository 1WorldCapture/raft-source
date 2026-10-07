// Private-deployment update affordance for the desktop top bar (phase 3-2).
//
// Unsigned private builds cannot auto-update (Squirrel.Mac rejects them —
// verified on real hardware), so the flow is detect → notify → the user
// installs manually. The pill appears when the private checker (main
// process) reports a newer version on the current server; clicking asks
// MAIN to open the download (the validated URL never crosses to the
// renderer). The hover text carries the unsigned-package install steps
// (Gatekeeper), mirrored in the desktop README.
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";

export type PrivateUpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; size?: number }
  | { state: "none" };

interface PrivateUpdateBridge {
  getStatus(): Promise<PrivateUpdateStatus>;
  onStatus(handler: (status: PrivateUpdateStatus) => void): () => void;
  checkNow(): void;
  openDownload(): void;
}

function getPrivateUpdateBridge(): PrivateUpdateBridge | null {
  return (globalThis as { raftDesktop?: { privateUpdate?: PrivateUpdateBridge } }).raftDesktop?.privateUpdate ?? null;
}

export function usePrivateUpdateStatus(): PrivateUpdateStatus {
  const [status, setStatus] = useState<PrivateUpdateStatus>({ state: "idle" });
  useEffect(() => {
    const bridge = getPrivateUpdateBridge();
    if (!bridge) return;
    let alive = true;
    void bridge.getStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    const unsubscribe = bridge.onStatus((s) => { if (alive) setStatus(s); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  return status;
}

export function PrivateUpdatePill() {
  const status = usePrivateUpdateStatus();
  const { formatMessage } = useIntl();

  if (status.state !== "available") return null;

  return (
    <button
      type="button"
      onClick={() => getPrivateUpdateBridge()?.openDownload()}
      title={formatMessage({ id: "desktop.privateUpdate.hint" })}
      className="inline-flex h-8 shrink-0 items-center border-2 border-black bg-soft-signal px-2.5 text-[12px] font-bold text-black shadow-brutal-sm transition-colors hover:bg-black hover:text-soft-signal"
    >
      {formatMessage({ id: "desktop.privateUpdate.pill" }, { version: status.version })}
    </button>
  );
}
