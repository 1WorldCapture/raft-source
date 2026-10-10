// The migration dialog: shown over the whole app (not only the Computers list) so a migration that was already
// running when the app started is visible and cancellable from the first screen. See migrationLogic.ts.
import { useState } from "react";
import Button from "@web/components/ui/Button";
import { deriveMigrationView, type MigrationAction, type StepTone } from "./migrationLogic";
import { useMigration } from "./useMigration";

const STEP_MARK: Record<StepTone, string> = { todo: "○", running: "◐", ok: "●", fail: "✕", skipped: "–" };

export default function MigrationDialog() {
  const { state, run, error } = useMigration();
  const view = deriveMigrationView(state);
  // In-app confirmation: window.confirm is a synchronous native modal that freezes the renderer until answered.
  const [asking, setAsking] = useState<MigrationAction | null>(null);
  return (
    <>
      {view.open ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" data-testid="migrate-computer-dialog" role="dialog" aria-modal="true">
          <div className="w-[420px] max-w-[92vw] border-2 border-black bg-white p-4 shadow-[4px_4px_0_0_#000]">
            <div className="text-sm font-bold text-black">{view.title}</div>
            <div className="mt-2 space-y-1.5 text-xs text-black/70">
              {view.lines.map((line) => <p key={line} className="break-words">{line}</p>)}
            </div>
            {view.steps.length > 0 ? (
              <ul className="mt-3 space-y-1 border-t-2 border-black/10 pt-2 text-xs" data-testid="migrate-steps">
                {view.steps.map((step) => (
                  <li key={step.key} className={step.tone === "fail" ? "text-brutal-pink" : step.tone === "skipped" ? "text-black/40" : "text-black"}>
                    <span className="mr-1.5 font-mono">{STEP_MARK[step.tone]}</span>
                    {step.label}
                    {step.note ? <span className="ml-1 text-black/50">({step.note})</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? <div className="mt-2 text-[11px] font-medium text-brutal-orange">{error}</div> : null}
            {asking ? (
              <div className="mt-4 border-t-2 border-black/10 pt-2" data-testid="migrate-confirm">
                <p className="text-xs font-medium text-black">{asking.confirm}</p>
                <div className="mt-2 flex justify-end gap-1.5">
                  <Button size="xs" tone="pink" emphasis="high" onClick={() => { const a = asking; setAsking(null); void run(a.id); }}>
                    Yes, continue
                  </Button>
                  <Button size="xs" onClick={() => setAsking(null)}>Back</Button>
                </div>
              </div>
            ) : view.actions.length > 0 ? (
              <div className="mt-4 flex justify-end gap-1.5">
                {view.actions.map((action) => (
                  <Button
                    key={action.id}
                    size="xs"
                    tone={action.primary ? "pink" : undefined}
                    emphasis={action.primary ? "high" : undefined}
                    onClick={() => {
                      if (action.confirm) setAsking(action);
                      else void run(action.id);
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
