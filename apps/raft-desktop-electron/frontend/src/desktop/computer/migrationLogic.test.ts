import assert from "node:assert/strict";
import test from "node:test";
import { deriveMigrationView, type MigrationState } from "./migrationLogic.ts";

const base: MigrationState = { phase: "ready", from: "/app/home", to: "/home/u/.slock", steps: [], blockers: [], warnings: [], error: null, resultFile: null, relaunching: false };
const ids = (s: MigrationState | null) => deriveMigrationView(s).actions.map((a) => a.id);

test("hidden when the build carries no Computer, and while idle (only the entry button shows)", () => {
  assert.deepEqual([deriveMigrationView(null).available, deriveMigrationView({ ...base, phase: "unavailable" }).available], [false, false]);
  const idle = deriveMigrationView({ ...base, phase: "idle" });
  assert.deepEqual([idle.available, idle.open], [true, false]);
});

test("ready: says where it goes and that agents go offline; Move now asks first; warnings are shown", () => {
  const view = deriveMigrationView({ ...base, warnings: ["an old login item will be removed"] });
  assert.equal(view.open, true);
  assert.match(view.lines.join(" "), /\/home\/u\/\.slock/);
  assert.match(view.lines.join(" "), /offline/);
  assert.match(view.lines.join(" "), /rolled back automatically/);
  assert.ok(view.lines.includes("an old login item will be removed"));
  assert.deepEqual(ids({ ...base }), ["apply", "close"]);
  assert.match(view.actions[0].confirm ?? "", /offline/);
});

test("blocked: lists the blockers, offers a re-check, no Move", () => {
  const view = deriveMigrationView({ ...base, phase: "blocked", blockers: ["target is not empty"] });
  assert.deepEqual(view.lines, ["target is not empty"]);
  assert.deepEqual(ids({ ...base, phase: "blocked" }), ["recheck", "close"]);
});

test("applying and success cannot be dismissed; the plan steps render in plain words with their reasons", () => {
  const applying = deriveMigrationView({ ...base, phase: "applying", steps: [{ step: "stop", status: "ok" }, { step: "move", status: "start" }, { step: "alias", status: "skipped", detail: { reason: "no symlink" } }] });
  assert.equal(applying.locked, true);
  assert.deepEqual(applying.actions, []);
  assert.deepEqual(applying.steps.map((s) => [s.label, s.tone, s.note]), [
    ["Stop the Computer", "ok", null],
    ["Move its data to the new location", "running", null],
    ["Keep the old path pointing at it", "skipped", "no symlink"],
  ]);
  const done = deriveMigrationView({ ...base, phase: "success", relaunching: true, resultFile: "/home/u/.slock/computer/migrate-result.json" });
  assert.deepEqual([done.locked, done.title], [true, "Done. Restarting the app…"]);
  assert.match(done.lines.join(" "), /no longer stops your agents/);
  assert.match(done.lines.join(" "), /migrate-result\.json/);
});

test("the passed preflight step is not listed (it is the check itself); a blocked one is", () => {
  assert.deepEqual(deriveMigrationView({ ...base, steps: [{ step: "preflight", status: "ok" }, { step: "stop", status: "planned" }] }).steps.map((s) => s.key), ["stop"]);
});

test("rolled back says nothing changed; failed says agents may be offline; error shows the reason; each can be retried or closed", () => {
  const rolled = deriveMigrationView({ ...base, phase: "rolled_back", error: "self-check failed" });
  assert.equal(rolled.title, "Nothing changed");
  assert.ok(rolled.lines.includes("self-check failed"));
  assert.deepEqual(ids({ ...base, phase: "rolled_back" }), ["recheck", "close"]);
  assert.match(deriveMigrationView({ ...base, phase: "failed" }).lines.join(" "), /may be offline/);
  assert.deepEqual(ids({ ...base, phase: "failed" }), ["close"]);
  const err = deriveMigrationView({ ...base, phase: "error", error: "unknown command 'migrate-home'" });
  assert.match(err.lines[0], /too old/);
  assert.deepEqual(deriveMigrationView({ ...base, phase: "error", error: "disk full" }).lines, ["disk full"]);
});

test("every step the Computer can report has a plain-language label (no raw step names in the dialog)", async () => {
  const { STEP_LABELS } = await import("./migrationLogic.ts");
  for (const step of ["preflight", "source-carrier", "stop", "move", "alias", "sessions", "home-env", "backup", "start", "self-check", "rollback"]) {
    assert.ok(STEP_LABELS[step], step);
  }
});

test("known Computer error codes read as sentences; unknown text is shown as reported", async () => {
  const { friendlyMigrationError } = await import("./migrationLogic.ts");
  assert.match(friendlyMigrationError("CliExit(1 NO_ATTACHMENT)"), /No server is connected/);
  assert.match(friendlyMigrationError("error: unknown command 'migrate-home'"), /too old/);
  assert.equal(friendlyMigrationError("disk full"), "disk full");
  const rolled = deriveMigrationView({ ...base, phase: "rolled_back", error: "CliExit(1 NO_ATTACHMENT)" });
  assert.match(rolled.lines.join(" "), /No server is connected/);
});

test("in-place: the button and text say Switch, and that no data is moved", () => {
  const view = deriveMigrationView({ ...base, inPlace: true, from: "/h/.slock", to: "/h/.slock" });
  assert.equal(view.title, "Switch to the independent Computer?");
  assert.match(view.lines.join(" "), /No data is moved/);
  assert.equal(view.actions[0].label, "Switch now");
  assert.match(view.actions[0].confirm ?? "", /Switch to the independent Computer/);
  assert.equal(deriveMigrationView({ ...base, phase: "applying", inPlace: true }).title, "Switching the Computer…");
  assert.equal(deriveMigrationView(base).actions[0].label, "Move now");
});

test("applying: Cancel appears only once the command runs, asks first, and becomes 'Cancelling…'", () => {
  assert.deepEqual(ids({ ...base, phase: "applying" }), []);
  const cancellable = deriveMigrationView({ ...base, phase: "applying", cancellable: true });
  assert.deepEqual(cancellable.actions.map((a) => a.id), ["cancel"]);
  assert.match(cancellable.actions[0].confirm ?? "", /rolled back/);
  const cancelling = deriveMigrationView({ ...base, phase: "applying", cancellable: true, cancelRequested: true });
  assert.equal(cancelling.title, "Cancelling…");
  assert.deepEqual(cancelling.actions, []);
});

test("a switch found already running at launch says so, with its deadline", () => {
  const view = deriveMigrationView({ ...base, phase: "applying", supervising: true, cancellable: true, deadlineAt: "2026-10-10T10:07:00" });
  assert.equal(view.title, "Finishing the switch…");
  assert.match(view.lines.join(" "), /still running/);
  assert.match(view.lines.join(" "), /10:07/);
  assert.equal(view.locked, true);
});

test("cancelled and timed-out rollbacks are named; the hand-over step has a plain label", () => {
  assert.equal(deriveMigrationView({ ...base, phase: "rolled_back", reason: "cancelled" }).title, "Cancelled");
  assert.match(deriveMigrationView({ ...base, phase: "rolled_back", reason: "deadline" }).lines.join(" "), /ran out of time/);
  assert.equal(deriveMigrationView({ ...base, phase: "applying", steps: [{ step: "handover", status: "start" }] }).steps[0].label, "Stop the built-in Computer");
});
