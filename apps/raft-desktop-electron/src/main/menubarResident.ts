// Menubar residency: per the 2026-09-27 product decision, closing the window
// never quits the app — the window is hidden (and the Dock icon with it), and
// a menu-bar Tray icon becomes the app's only visible presence. Every re-open
// path — tray click, tray menu, Dock/Spotlight/`open -a` (second-instance),
// activate — funnels through the same `reveal` callback. Quitting stays an
// explicit act and keeps its current behavior; stopping the background
// service on quit is task #7.
import { Menu, Tray, app, nativeImage } from "electron";
import type { MenuItemConstructorOptions } from "electron";

export interface TrayStatus {
  /** Attached servers whose daemon is live and connected — "N agents". */
  readonly runningAgents: number;
}

/** Pure: should a window `close` event be intercepted as hide-to-menubar?
 * Only macOS hides (other platforms keep real close semantics), and only
 * outside an actual quit — Cmd+Q / Quit menu run with quitting=true and the
 * window must close for real or the app can never exit. */
export function shouldHideOnClose(input: { quitting: boolean; platform: NodeJS.Platform }): boolean {
  return input.platform === "darwin" && !input.quitting;
}

/** Pure: count attached servers with a live, connected daemon. Tolerates
 * unknown/legacy reports (missing rows count as not running). */
export function runningAgentsFromStatusReport(
  report: { servers?: ReadonlyArray<{ serverConnected?: boolean }> } | null | undefined,
): number {
  return (report?.servers ?? []).filter((row) => row.serverConnected === true).length;
}

/** Pure: the tray context-menu template. Wording mirrors the native app
 * menu's English strings; the agent row is informational (disabled). */
export function buildTrayMenuTemplate(input: {
  appName: string;
  status: TrayStatus;
  onShow(): void;
}): MenuItemConstructorOptions[] {
  const { appName, status, onShow } = input;
  const agentWord = status.runningAgents === 1 ? "agent" : "agents";
  return [
    { label: `Show ${appName}`, click: onShow },
    { type: "separator" },
    {
      label: `Local ${agentWord} running: ${status.runningAgents}`,
      enabled: false,
    },
    { type: "separator" },
    // role:"quit" routes through the standard quit path (before-quit → real
    // window close). The quit-stops-service confirmation is task #7.
    { role: "quit", label: `Quit ${appName}` },
  ];
}

/**
 * Owns the Tray icon and its menu. Agent counts are fed from the existing
 * 5s computer-status poll (no new IPC): whoever broadcasts the report also
 * calls {@link setStatusReport}.
 *
 * The icon is rendered as a template image so macOS re-colors it for both
 * light and dark menu bars. `iconPath` is a 16px base; an adjacent
 * `...@2x.png` file is attached as the Retina representation when present.
 */
export class MenubarResident {
  private tray: Tray | null = null;
  private status: TrayStatus = { runningAgents: 0 };

  constructor(
    private readonly deps: {
      iconPath: string;
      /** Unified "show the window" funnel (restore or recreate). */
      reveal(): void;
    },
  ) {}

  install(): void {
    const icon = nativeImage.createFromPath(this.deps.iconPath);
    const icon2x = nativeImage.createFromPath(this.deps.iconPath.replace(/(\.png)$/, "@2x$1"));
    // Attach the Retina representation as PNG bytes — AddRepresentationOptions
    // takes buffer/dataURL, not a NativeImage or a path.
    if (!icon2x.isEmpty()) icon.addRepresentation({ scaleFactor: 2, buffer: icon2x.toPNG() });
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    // Bare tray click behaves like the Dock icon: show the window. On macOS
    // a click also toggles the context menu by default — bind explicitly so
    // both gestures do something predictable.
    this.tray.on("click", () => this.deps.reveal());
    this.refreshMenu();
  }

  setStatusReport(report: { servers?: ReadonlyArray<{ serverConnected?: boolean }> } | null | undefined): void {
    this.status = { runningAgents: runningAgentsFromStatusReport(report) };
    this.refreshMenu();
  }

  private refreshMenu(): void {
    const tray = this.tray;
    if (!tray) return;
    tray.setContextMenu(
      Menu.buildFromTemplate(
        buildTrayMenuTemplate({
          appName: app.getName(),
          status: this.status,
          onShow: () => this.deps.reveal(),
        }),
      ),
    );
    tray.setToolTip(`Raft Desktop — ${this.status.runningAgents} local agent(s) running`);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
