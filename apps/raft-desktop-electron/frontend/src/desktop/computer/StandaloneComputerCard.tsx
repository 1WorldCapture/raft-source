// "This Computer" card for a machine whose Computer is a standalone `raft-computer` (see standaloneCardLogic.ts).
// Same slot and look as ThisComputerCard, but it only shows status and Start / Stop / Install / Update:
// the Computer is not hosted by this app, so closing the app never stops it.
import { useState, type KeyboardEvent } from "react";
import { Monitor } from "lucide-react";
import Button from "@web/components/ui/Button";
import StatusDot from "@web/components/ui/StatusDot";
import { MachineRunLabel } from "@web/components/machine/MachineRunLabel";
import { useAppNavigate } from "@web/hooks/useAppNavigate";
import { getComputerRowDotStatus, getComputerRowDotTone } from "@web/utils/computerUpgradeIndicator";
import { deriveStandaloneCard, friendlyStandaloneError, type StandaloneAction } from "./standaloneCardLogic";
import { useSelfMachine } from "./useSelfComputer";
import { useStandaloneComputer } from "./useStandaloneComputer";

const DOT_TONE = { ok: "bg-brutal-lime", idle: "bg-gray-400", warn: "bg-brutal-orange", error: "bg-brutal-pink" } as const;

export default function StandaloneComputerCard() {
  const { state, busy, error, run } = useStandaloneComputer();
  const model = deriveStandaloneCard(state);
  // This device's own row on the server (same correlation as the embedded card). When found, the card IS that row
  // (name, status, agents come from the server; click opens its detail) and the plain row is hidden by the mount.
  const selfMachine = useSelfMachine();
  const nav = useAppNavigate();
  const openDetail = () => { if (selfMachine) nav.toComputer(selfMachine.id); };
  // In-app confirmation: window.confirm is a synchronous native modal that freezes the renderer until answered.
  const [asking, setAsking] = useState<StandaloneAction | null>(null);
  return (
    <div className="mb-1.5 w-full border-2 border-black bg-white" data-testid="this-computer-card" data-standalone-computer="">
      <div
        {...(selfMachine ? {
          role: "button",
          tabIndex: 0,
          onClick: openDetail,
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); }
          },
        } : {})}
        className={`flex items-center gap-2.5 px-2.5 py-2${selfMachine ? " cursor-pointer transition-colors hover:bg-soft-signal/25" : ""}`}
      >
        <div className="relative flex size-9 shrink-0 items-center justify-center border-2 border-black bg-soft-signal">
          <Monitor size={18} />
          <StatusDot
            className="absolute -right-1 -top-1"
            tone={selfMachine && model.tone === "ok" ? getComputerRowDotTone(getComputerRowDotStatus(selfMachine)) : DOT_TONE[model.tone]}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-bold text-black">{selfMachine ? selfMachine.name : model.title}</span>
            <span className="shrink-0 border border-black bg-soft-signal px-1 text-[10px] font-bold uppercase tracking-wide text-black">
              This device
            </span>
          </div>
          {selfMachine ? (
            <>
              <div className="mt-0.5 truncate font-mono text-[11px] text-black/50"><MachineRunLabel machine={selfMachine} /></div>
              {model.tone !== "ok" ? <div className="mt-0.5 text-[11px] font-medium text-black/70">{model.title}{model.detail ? ` — ${model.detail}` : ""}</div> : null}
            </>
          ) : model.detail ? <div className="mt-0.5 text-[11px] text-black/60">{model.detail}</div> : null}
          {model.version ? <div className="mt-0.5 font-mono text-[10px] text-black/40">Computer {model.version}</div> : null}
        </div>
      </div>
      {error || model.actions.length > 0 ? (
        <div className="border-t-2 border-black/10 px-2.5 py-1.5">
          {error ? <div className="mb-1 text-[11px] font-medium text-brutal-orange">{friendlyStandaloneError(error)}</div> : null}
          {asking ? (
            <div data-testid="standalone-confirm">
              <p className="mb-1 text-[11px] font-medium text-black">{asking.confirm}</p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="xs" tone="pink" emphasis="high" disabled={busy != null} onClick={() => { const a = asking; setAsking(null); void run(a.id); }}>
                  Yes, continue
                </Button>
                <Button size="xs" onClick={() => setAsking(null)}>Back</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {model.actions.map((action) => (
                <Button
                  key={action.id}
                  size="xs"
                  tone={action.primary ? "pink" : undefined}
                  emphasis={action.primary ? "high" : undefined}
                  disabled={busy != null}
                  onClick={() => {
                    if (action.confirm) setAsking(action);
                    else void run(action.id);
                  }}
                >
                  {busy === action.id ? "Working…" : action.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
