// Pins the quit-flow decisions (task #7): the confirmation dialog is skipped
// for "don't ask again", for OS shutdown (a modal there would hang logout),
// and when nothing is running; the copy names a real agent count only when
// the reporter supplied one; cancelling aborts the quit; the checked box
// persists the preference. One electron mock (dialog + powerMonitor) backs
// the whole file, like menubarResident.test.ts.
import assert from "node:assert/strict";
import test from "node:test";

let dialogResponse = { response: 0, checkboxChecked: false };
const dialogCalls: number[] = [];
let shutdownHandler: (() => void) | null = null;

test("quit flow: when to ask, copy truthfulness, cancel vs proceed", async (t) => {
  t.mock.module("electron", { namedExports: {
    dialog: {
      showMessageBox: async () => {
        dialogCalls.push(dialogCalls.length);
        return { response: dialogResponse.response, checkboxChecked: dialogResponse.checkboxChecked };
      },
    },
    powerMonitor: {
      on: (event: string, handler: () => void) => {
        if (event === "shutdown") shutdownHandler = handler;
      },
    },
  } });
  const { shouldAskQuitConfirm, quitDialogCopy, runQuitFlow, createQuitController } = await import("./quitFlow.ts");

  await t.test("shouldAskQuitConfirm: skip for pref, OS shutdown, nothing running", () => {
    const base = { prefs: { quitNoConfirm: false }, osShuttingDown: false, anythingRunning: true };
    assert.equal(shouldAskQuitConfirm(base), true);
    assert.equal(shouldAskQuitConfirm({ ...base, prefs: { quitNoConfirm: true } }), false);
    assert.equal(shouldAskQuitConfirm({ ...base, osShuttingDown: true }), false);
    assert.equal(shouldAskQuitConfirm({ ...base, anythingRunning: false }), false);
  });

  await t.test("quitDialogCopy: real count only when provided; pluralization", () => {
    const withCount = quitDialogCopy(3);
    assert.match(withCount.detail, /3 local agents/);
    const single = quitDialogCopy(1);
    assert.match(single.detail, /1 local agent/);
    const unknown = quitDialogCopy(null);
    assert.match(unknown.detail, /all local agents/);
    assert.doesNotMatch(unknown.detail, /\d+ local agents?/, "never invents a number");
  });

  type QuitFlowDeps = Parameters<typeof runQuitFlow>[0];
  const makeDeps = (overrides: Partial<QuitFlowDeps> = {}) => {
    const saved: unknown[] = [];
    const orchestrated: number[] = [];
    const deps: QuitFlowDeps = {
      anythingRunning: async () => true,
      agentCount: async () => 2 as number | null,
      prefs: () => ({ quitNoConfirm: false }),
      savePrefs: (prefs: { quitNoConfirm: boolean }) => saved.push(prefs),
      orchestrateShutdown: async () => {
        orchestrated.push(1);
      },
      quit: () => {},
      ...overrides,
    };
    return { deps, saved, orchestrated };
  };

  await t.test("cancel aborts the quit without stopping anything", async () => {
    dialogResponse = { response: 1, checkboxChecked: false };
    dialogCalls.length = 0;
    const { deps, orchestrated } = makeDeps();
    const proceed = await runQuitFlow(deps);
    assert.equal(proceed, false);
    assert.equal(orchestrated.length, 0, "cancel must not stop the background tree");
    assert.equal(dialogCalls.length, 1);
  });

  await t.test("confirm runs the ladder; checkbox persists the preference", async () => {
    dialogResponse = { response: 0, checkboxChecked: true };
    const { deps, saved, orchestrated } = makeDeps();
    const proceed = await runQuitFlow(deps);
    assert.equal(proceed, true);
    assert.equal(orchestrated.length, 1);
    assert.deepEqual(saved, [{ quitNoConfirm: true }]);
  });

  await t.test("nothing running: no dialog, still scans for orphaned processes", async () => {
    dialogCalls.length = 0;
    const { deps, orchestrated } = makeDeps({ anythingRunning: async () => false });
    const proceed = await runQuitFlow(deps);
    assert.equal(proceed, true);
    assert.equal(dialogCalls.length, 0);
    assert.equal(orchestrated.length, 1);
  });

  await t.test("repeated quit stays intercepted until cleanup completes", async () => {
    let release!: (proceed: boolean) => void;
    let attempts = 0;
    let completes = 0;
    let intercepted = 0;
    const controller = createQuitController({
      attempt: () => { attempts++; return new Promise<boolean>((resolve) => { release = resolve; }); },
      complete: () => { completes++; }, failed: () => assert.fail("unexpected error"),
    });
    const event = { preventDefault: () => { intercepted++; } };
    controller.beforeQuit(event);
    controller.beforeQuit(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.equal(intercepted, 2);
    assert.equal(completes, 0);
    release(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.beforeQuit(event);
    assert.equal(completes, 1);
    assert.equal(intercepted, 2);
  });

  await t.test("cancel and error allow a later quit retry", async () => {
    let attempts = 0;
    let errors = 0;
    let completes = 0;
    const controller = createQuitController({
      attempt: async () => { attempts++; if (attempts === 1) return false; if (attempts === 2) throw new Error("scan failed"); return true; },
      complete: () => { completes++; }, failed: () => { errors++; },
    });
    for (let i = 0; i < 3; i++) {
      controller.beforeQuit({ preventDefault() {} });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(errors, 1);
    assert.equal(completes, 1);
  });

  await t.test("OS shutdown skips the dialog but still runs the ladder", async () => {
    dialogCalls.length = 0;
    shutdownHandler?.(); // macOS notified shutdown early
    const { deps, orchestrated } = makeDeps();
    const proceed = await runQuitFlow(deps);
    assert.equal(proceed, true);
    assert.equal(dialogCalls.length, 0, "never modal during OS shutdown");
    assert.equal(orchestrated.length, 1, "but the tree must still be stopped");
  });
});
