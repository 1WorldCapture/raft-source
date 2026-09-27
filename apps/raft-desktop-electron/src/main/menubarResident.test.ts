// Pins the menubar-residency contract (task: close-to-tray): a window close
// outside a real quit is intercepted as hide (macOS only), every reveal path
// funnels through one callback, and the tray menu reflects the number of
// live local agents.
//
// One electron mock backs the whole file (module cache): menubarResident is
// imported once after t.mock.module, and the tray-wiring subtest drives the
// mutable FakeTray state — the same pattern as windowState.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";

// Shared mutable state the FakeTray writes into, reset per subtest.
let createdTray: {
  handler?: () => void;
  destroyed: boolean;
} | null = null;
const calls: string[] = [];
const menuTemplateRef: { current: MenuItemConstructorOptions[] | null } = { current: null };

class FakeTray {
  handler?: () => void;
  destroyed = false;
  constructor(public image: unknown) {
    this.destroyed = false;
    createdTray = this;
  }
  on(_event: string, handler: () => void) { this.handler = handler; }
  setContextMenu(menu: { template: MenuItemConstructorOptions[] }) { menuTemplateRef.current = menu.template; }
  setToolTip(_tip: string) { calls.push("tooltip"); }
  destroy() { this.destroyed = true; calls.push("destroy"); }
}

const fakeImages = new Map<string, {
  isEmpty(): boolean;
  setTemplateImage(v: boolean): void;
  addRepresentation(r: unknown): void;
  toPNG(): Buffer;
}>();
const makeImage = (empty = false) => {
  const state = { template: false, reps: 0, empty };
  return {
    isEmpty: () => state.empty,
    setTemplateImage: (v: boolean) => { state.template = v; },
    addRepresentation: (r: unknown) => { state.reps += 1; assert.equal((r as { scaleFactor: number }).scaleFactor, 2, "retina representation must be scale 2"); },
    toPNG: () => Buffer.alloc(0),
    snapshot: () => state,
  };
};
fakeImages.set("/icons/tray-icon.png", makeImage());
fakeImages.set("/icons/tray-icon@2x.png", makeImage());

test("menubar residency: close-to-hide decision, agent counting, tray lifecycle", async (t) => {
  t.mock.module("electron", { namedExports: {
    app: { getName: () => "Raft Desktop" },
    Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => ({ template }) },
    nativeImage: { createFromPath: (p: string) => fakeImages.get(p) ?? makeImage(true) },
    Tray: FakeTray as unknown as typeof Electron.Tray,
  } });
  const { shouldHideOnClose, runningAgentsFromStatusReport, buildTrayMenuTemplate, MenubarResident } =
    await import("./menubarResident.ts");

  await t.test("shouldHideOnClose: darwin hides only outside a real quit", () => {
    assert.equal(shouldHideOnClose({ quitting: false, platform: "darwin" }), true);
    // Cmd+Q / Quit menu run with quitting=true — the window must close for
    // real or the app can never exit.
    assert.equal(shouldHideOnClose({ quitting: true, platform: "darwin" }), false);
    // Other platforms keep real close semantics.
    assert.equal(shouldHideOnClose({ quitting: false, platform: "win32" }), false);
    assert.equal(shouldHideOnClose({ quitting: false, platform: "linux" }), false);
  });

  await t.test("runningAgentsFromStatusReport counts only connected rows and tolerates gaps", () => {
    assert.equal(runningAgentsFromStatusReport({ servers: [{ serverConnected: true }, { serverConnected: false }] }), 1);
    assert.equal(runningAgentsFromStatusReport({ servers: [{ serverConnected: true }, {}] }), 1);
    assert.equal(runningAgentsFromStatusReport({ servers: [] }), 0);
    assert.equal(runningAgentsFromStatusReport(null), 0);
    assert.equal(runningAgentsFromStatusReport(undefined), 0);
  });

  await t.test("tray menu template: show entry fires reveal, agent row is informational, quit present", () => {
    let revealed = 0;
    const template = buildTrayMenuTemplate({ appName: "Raft Desktop", status: { runningAgents: 2 }, onShow: () => { revealed += 1; } });
    const show = template.find((item) => item.label === "Show Raft Desktop") as { click?: () => void };
    assert.ok(show, "template must contain a Show entry");
    show.click?.();
    assert.equal(revealed, 1, "Show entry must call the reveal callback");
    const agentRow = template.find((item) => typeof item.label === "string" && item.label.startsWith("Local "));
    assert.equal(agentRow?.label, "Local agents running: 2");
    assert.equal(agentRow?.enabled, false, "agent row is a status label, not clickable");
    assert.ok(template.some((item) => item.role === "quit"), "template must keep a Quit entry");
    // Singular wording for exactly one agent.
    const single = buildTrayMenuTemplate({ appName: "Raft Desktop", status: { runningAgents: 1 }, onShow: () => {} });
    assert.ok(single.some((item) => item.label === "Local agent running: 1"));
  });

  await t.test("MenubarResident: click and Show reveal; status updates refresh menu; destroy tears down", () => {
    createdTray = null;
    calls.length = 0;
    const reveals: number[] = [];
    const resident = new MenubarResident({ iconPath: "/icons/tray-icon.png", reveal: () => reveals.push(1) });
    resident.install();
    // Bare tray click reveals the window.
    const tray = (): { handler?: () => void } | null => createdTray;
    assert.ok(tray(), "install must create a Tray");
    tray()?.handler?.();
    assert.equal(reveals.length, 1, "tray click must funnel to reveal");
    // The Show menu entry routes to the same reveal funnel.
    const show = menuTemplateRef.current?.find((item) => item.label === "Show Raft Desktop") as { click?: () => void };
    show?.click?.();
    assert.equal(reveals.length, 2, "Show menu entry must funnel to reveal");
    // Status refresh updates the informational row.
    resident.setStatusReport({ servers: [{ serverConnected: true }, { serverConnected: true }, { serverConnected: false }] });
    const agentRow = menuTemplateRef.current?.find((item) => typeof item.label === "string" && item.label.startsWith("Local "));
    assert.equal(agentRow?.label, "Local agents running: 2");
    resident.destroy();
    assert.ok(calls.includes("destroy"), "destroy must tear the tray down");
  });
});
