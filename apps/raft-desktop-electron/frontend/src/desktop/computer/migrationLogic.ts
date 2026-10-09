// What the "Run the Computer independently" dialog shows for each phase of the main-process migration
// (src/app/standalone/migration.ts). Pure: MigrationState in, a display model out (unit-tested in
// migrationLogic.test.ts); the component only renders it.

export type MigrationPhase = "unavailable" | "idle" | "checking" | "ready" | "blocked" | "applying" | "success" | "rolled_back" | "failed" | "error";

/** The slice of the main-process MigrationState the dialog reads (structural: the renderer does not import main-process code). */
export interface MigrationState {
  phase: MigrationPhase;
  from: string | null;
  to: string | null;
  steps: Array<{ step: string; status: string; detail?: Record<string, unknown> }>;
  blockers: string[];
  warnings: string[];
  error: string | null;
  resultFile: string | null;
  relaunching: boolean;
}

export type MigrationActionId = "apply" | "recheck" | "close";

export interface MigrationAction {
  id: MigrationActionId;
  label: string;
  primary: boolean;
  /** Asked before running (the move takes agents offline). */
  confirm: string | null;
}

export type StepTone = "todo" | "running" | "ok" | "fail" | "skipped";

export interface MigrationStepView {
  key: string;
  label: string;
  tone: StepTone;
  note: string | null;
}

export interface MigrationView {
  /** Whether the entry button is shown at all. */
  available: boolean;
  /** Whether the dialog is showing (phase other than idle/unavailable). */
  open: boolean;
  tone: "idle" | "busy" | "ok" | "warn" | "error";
  title: string;
  lines: string[];
  steps: MigrationStepView[];
  actions: MigrationAction[];
  /** Phases in which the dialog cannot be dismissed. */
  locked: boolean;
}

export const STEP_LABELS: Record<string, string> = {
  preflight: "Check this machine",
  "source-carrier": "Retire the old login item",
  stop: "Stop the Computer",
  move: "Move its data to the new location",
  alias: "Keep the old path pointing at it",
  sessions: "Keep agent chat sessions attached to the new path",
  "home-env": "Remove the old environment helper",
  backup: "Back up what was removed",
  start: "Start the independent Computer",
  "self-check": "Check that agents are back online",
  rollback: "Restore the previous setup",
};

/** The Computer's own error codes, in words a person can act on; anything else is shown as reported. */
export function friendlyMigrationError(raw: string): string {
  if (/NO_ATTACHMENT/.test(raw)) return "No server is connected to this Computer yet, so it could not be started on its own. Connect it to a server first.";
  if (/unknown command|migrate-home/i.test(raw) && /unknown|not found|ENOENT/i.test(raw)) return "The installed raft-computer is too old to move the Computer. Update it and try again.";
  return raw;
}

const act = (id: MigrationActionId, label: string, primary = false, confirm: string | null = null): MigrationAction => ({ id, label, primary, confirm });

function stepTone(status: string): StepTone {
  if (status === "start") return "running";
  if (status === "ok") return "ok";
  if (status === "fail" || status === "blocked") return "fail";
  if (status === "skipped") return "skipped";
  return "todo"; // planned
}

function stepNote(step: { step: string; status: string; detail?: Record<string, unknown> }): string | null {
  const detail = step.detail;
  if (!detail) return null;
  if (typeof detail.reason === "string") return detail.reason;
  if (typeof detail.error === "string") return detail.error;
  if (typeof detail.note === "string") return detail.note;
  return null;
}

export function deriveMigrationView(state: MigrationState | null): MigrationView {
  const none: MigrationView = { available: false, open: false, tone: "idle", title: "", lines: [], steps: [], actions: [], locked: false };
  if (!state || state.phase === "unavailable") return none;
  const steps: MigrationStepView[] = state.steps
    .filter((s) => !(s.step === "preflight" && s.status === "ok"))
    .map((s) => ({ key: s.step, label: STEP_LABELS[s.step] ?? s.step, tone: stepTone(s.status), note: stepNote(s) }));
  const base = { available: true, steps, locked: false };
  const to = state.to ?? "the standard location";
  const resultLine = state.resultFile ? [`Details: ${state.resultFile}`] : [];
  switch (state.phase) {
    case "idle":
      return { ...base, open: false, tone: "idle", title: "", lines: [], steps: [], actions: [] };
    case "checking":
      return { ...base, open: true, tone: "busy", title: "Checking this machine…", lines: ["Nothing is changed during this check."], steps: [], actions: [act("close", "Cancel")] };
    case "ready":
      return {
        ...base,
        open: true,
        tone: "idle",
        title: "Run the Computer independently?",
        lines: [
          `The Computer and its agents move out of this app to ${to}. They keep running when you close the app.`,
          "Agents on this machine go offline for about a minute. If anything goes wrong, everything is rolled back automatically.",
          ...state.warnings,
        ],
        actions: [act("apply", "Move now", true, "Move the Computer out of this app now? Its agents go offline for about a minute, and this app restarts when it is done."), act("close", "Cancel")],
      };
    case "blocked":
      return {
        ...base,
        open: true,
        tone: "warn",
        title: "Can't move the Computer yet",
        lines: state.blockers.length > 0 ? state.blockers : ["The check found a problem. Nothing was changed."],
        steps: [],
        actions: [act("recheck", "Check again", true), act("close", "Close")],
      };
    case "applying":
      return { ...base, open: true, tone: "busy", title: "Moving the Computer…", lines: ["Keep this app open until it finishes. Agents are offline during the move."], locked: true, actions: [] };
    case "success":
      return {
        ...base,
        open: true,
        tone: "ok",
        title: state.relaunching ? "Done. Restarting the app…" : "Done",
        lines: [`The Computer now runs independently from ${to}. Closing the app no longer stops your agents.`, ...state.warnings, ...resultLine],
        locked: true,
        actions: [],
      };
    case "rolled_back":
      return {
        ...base,
        open: true,
        tone: "warn",
        title: "Nothing changed",
        lines: ["The move did not complete and was rolled back. The Computer is back the way it was.", ...(state.error ? [friendlyMigrationError(state.error)] : []), ...resultLine],
        actions: [act("recheck", "Try again", true), act("close", "Close")],
      };
    case "failed":
      return {
        ...base,
        open: true,
        tone: "error",
        title: "The move failed",
        lines: ["The move failed and the automatic rollback did not fully succeed. Your agents may be offline.", ...(state.error ? [friendlyMigrationError(state.error)] : []), ...resultLine],
        actions: [act("close", "Close", true)],
      };
    case "error":
      return {
        ...base,
        open: true,
        tone: "error",
        title: "Couldn't run the move",
        lines: [state.error ? friendlyMigrationError(state.error) : "The migration command did not report a result.", ...resultLine],
        steps: [],
        actions: [act("recheck", "Try again", true), act("close", "Close")],
      };
  }
}
