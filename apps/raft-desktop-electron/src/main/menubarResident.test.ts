// Pins the menubar-residency contract (task: close-to-tray): a window close
// outside a real quit is intercepted as hide (macOS only), every reveal path
// funnels through one callback, and the tray menu reports connected SERVERS
// (the status report counts servers, not agents). Left click reveals the
// window — no setContextMenu, or macOS would turn the left click into
// opening the menu — and right click pops the menu explicitly.
//
// One electron mock backs the whole file (module cache): menubarResident is
// imported once after t.mock.module, and the tray-wiring subtest drives the
// mutable FakeTray state — the same pattern as windowState.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";

// Shared mutable state the FakeTray writes into, reset per subtest.
let createdTray: FakeTray | null = null;
const calls: string[] = [];
const menuTemplateRef: { current: MenuItemConstructorOptions[] | null } = { current: null };

class FakeTray {
  leftClick?: () => void;
  rightClick?: () => void;
  popups = 0;
  contextMenuInstalled = false;
  destroyed = false;
  constructor(public image: unknown) {
    this.popups = 0;
    createdTray = this;
  }
  on(event: string, handler: () => void) {
    if (event === "click") this.leftClick = handler;
    if (event === "right-click") this.rightClick = handler;
  }
  // Installing a context menu via setContextMenu must NOT happen (it hijacks
  // the left click on macOS) — record it so the test can assert against it.
  setContextMenu(_menu: unknown) { this.contextMenuInstalled = true; }
  popUpContextMenu(_menu: unknown) { this.popups += 1; }
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

test("menubar residency: close-to-hide decision, server counting, tray lifecycle", async (t) => {
  t.mock.module("electron", { namedExports: {
    app: { getName: () => "Raft Desktop" },
    Menu: { buildFromTemplate: (template: MenuItemConstructorOptions[]) => { menuTemplateRef.current = template; return { template }; } },
    nativeImage: { createFromPath: (p: string) => fakeImages.get(p) ?? makeImage(true) },
    Tray: FakeTray as unknown as typeof Electron.Tray,
  } });
  const { shouldHideOnClose, connectedServersFromStatusReport, buildTrayMenuTemplate, MenubarResident } =
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

  await t.test("connectedServersFromStatusReport counts only connected rows and tolerates gaps", () => {
    assert.equal(connectedServersFromStatusReport({ servers: [{ serverConnected: true }, { serverConnected: false }] }), 1);
    assert.equal(connectedServersFromStatusReport({ servers: [{ serverConnected: true }, {}] }), 1);
    assert.equal(connectedServersFromStatusReport({ servers: [] }), 0);
    assert.equal(connectedServersFromStatusReport(null), 0);
    assert.equal(connectedServersFromStatusReport(undefined), 0);
  });

  await t.test("tray menu template: show entry fires reveal, servers row is informational, quit present", () => {
    let revealed = 0;
    const template = buildTrayMenuTemplate({ appName: "Raft Desktop", status: { connectedServers: 2 }, onShow: () => { revealed += 1; } });
    const show = template.find((item) => item.label === "Show Raft Desktop") as { click?: () => void };
    assert.ok(show, "template must contain a Show entry");
    show.click?.();
    assert.equal(revealed, 1, "Show entry must call the reveal callback");
    const serversRow = template.find((item) => typeof item.label === "string" && item.label.startsWith("Connected "));
    assert.equal(serversRow?.label, "Connected servers: 2");
    assert.equal(serversRow?.enabled, false, "servers row is a status label, not clickable");
    assert.ok(template.some((item) => item.role === "quit"), "template must keep a Quit entry");
  });

  await t.test("MenubarResident: left click reveals, right click pops menu, no setContextMenu; destroy tears down", () => {
    createdTray = null;
    calls.length = 0;
    const reveals: number[] = [];
    const resident = new MenubarResident({ iconPath: "/icons/tray-icon.png", reveal: () => reveals.push(1) });
    resident.install();
    // Wrap in a function: control-flow analysis otherwise narrows the closure
    // variable back to its null seed.
    const tray = (): FakeTray | null => createdTray;
    assert.ok(tray(), "install must create a Tray");
    assert.equal(tray()?.contextMenuInstalled, false, "must not install a context menu (it hijacks the left click)");
    // Left click reveals the window.
    tray()?.leftClick?.();
    assert.equal(reveals.length, 1, "tray left click must funnel to reveal");
    // Right click pops the menu instead.
    tray()?.rightClick?.();
    assert.equal(tray()?.popups, 1, "right click must pop up the menu");
    // The Show menu entry routes to the same reveal funnel.
    const show = menuTemplateRef.current?.find((item) => item.label === "Show Raft Desktop") as { click?: () => void };
    show?.click?.();
    assert.equal(reveals.length, 2, "Show menu entry must funnel to reveal");
    // Status refresh updates the informational row.
    resident.setStatusReport({ servers: [{ serverConnected: true }, { serverConnected: true }, { serverConnected: false }] });
    const serversRow = menuTemplateRef.current?.find((item) => typeof item.label === "string" && item.label.startsWith("Connected "));
    assert.equal(serversRow?.label, "Connected servers: 2");
    resident.destroy();
    assert.ok(calls.includes("destroy"), "destroy must tear the tray down");
  });
});
