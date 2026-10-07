// Owner-only native controls. No renderer IPC endpoint and no SDK import here.
// Provider errors are deliberately not interpolated: they can contain secrets.
export interface CursorSdkConnectionView {
  state: string;
  detail?: string;
}

export interface CursorSdkMenuDialog {
  type: "info" | "warning" | "error" | "question";
  title: string;
  message: string;
  detail?: string;
  buttons?: string[];
  cancelId?: number;
  defaultId?: number;
}

export interface CursorSdkMenuDependencies {
  status(): Promise<CursorSdkConnectionView>;
  connect(input: {
    browser: boolean;
    signal: AbortSignal;
    onLoginUrl(url: string): void;
  }): Promise<CursorSdkConnectionView>;
  disconnect(): Promise<void>;
  showMessage(input: CursorSdkMenuDialog): Promise<number>;
  openExternal(url: string): Promise<void>;
}

export function isCursorSdkLoginUrl(value: string): boolean {
  if (value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "cursor.com" || url.hostname === "www.cursor.com")
      && url.port === ""
      && !url.username && !url.password
      && url.pathname === "/loginDeepControl"
      && !url.searchParams.has("verifier");
  } catch {
    return false;
  }
}

/** Native controls are single-flight. The Broker also enforces cross-process locking. */
export class CursorSdkMenuController {
  private login: AbortController | null = null;

  constructor(private readonly deps: CursorSdkMenuDependencies) {}

  async showStatus(): Promise<void> {
    try {
      const result = await this.deps.status();
      await this.deps.showMessage({
        type: "info",
        title: "Cursor SDK",
        message: `Connection: ${result.state}`,
        detail: result.detail,
      });
    } catch {
      await this.showFailure("Unable to check the Cursor SDK connection. Verify the bundled runtime assets and try again.");
    }
  }

  async connect(): Promise<void> {
    if (this.login) {
      await this.deps.showMessage({
        type: "info", title: "Cursor SDK", message: "A sign-in request is already in progress.",
        detail: "Complete it in your browser, or choose Cursor SDK → Cancel Sign In.",
      });
      return;
    }
    const controller = new AbortController();
    this.login = controller;
    let openFailed = false;
    const openings: Promise<void>[] = [];
    try {
      const choice = await this.deps.showMessage({
        type: "question", title: "Connect Cursor SDK", message: "Choose how to connect Cursor to Raft.",
        detail: "Use Existing Login verifies the saved SDK login without signing in again. Browser Sign-In creates a separate Raft authorization through Cursor. Your existing Cursor CLI login is not changed.",
        buttons: ["Use Existing Login", "Browser Sign-In", "Cancel"], defaultId: 0, cancelId: 2,
      });
      if ((choice !== 0 && choice !== 1) || controller.signal.aborted) return;
      const result = await this.deps.connect({
        browser: choice === 1,
        signal: controller.signal,
        onLoginUrl: (url) => {
          if (controller.signal.aborted) return;
          if (!isCursorSdkLoginUrl(url)) {
            openFailed = true;
            controller.abort();
            return;
          }
          // Do not log or forward the transaction URL to the renderer/server.
          openings.push(this.deps.openExternal(url).catch(() => {
            openFailed = true;
            controller.abort();
          }));
        },
      });
      await Promise.all(openings);
      if (controller.signal.aborted) {
        if (openFailed) await this.showFailure("The Cursor sign-in page could not be opened safely. The sign-in request was cancelled.");
        return;
      }
      await this.deps.showMessage({
        type: "info", title: "Cursor SDK", message: `Connection: ${result.state}`,
        detail: result.detail ?? "Select Cursor SDK when creating an Agent on this computer.",
      });
    } catch {
      if (openFailed) {
        await this.showFailure("The Cursor sign-in page could not be opened safely. The sign-in request was cancelled.");
      } else if (!controller.signal.aborted) {
        await this.showFailure("Cursor could not be connected. Check Connection Status for a missing login, an account mismatch, or a local runtime asset problem. No alternate account was selected automatically.");
      }
    } finally {
      if (this.login === controller) this.login = null;
    }
  }

  cancelLogin(): void {
    this.login?.abort();
  }

  async disconnect(): Promise<void> {
    if (this.login) {
      await this.deps.showMessage({
        type: "info", title: "Cursor SDK", message: "Cancel the current sign-in request before disconnecting.",
      });
      return;
    }
    try {
      const choice = await this.deps.showMessage({
        type: "warning", title: "Disconnect Cursor SDK", message: "Disconnect Cursor from Raft on this computer?",
        detail: "Stop active Cursor SDK Agents first. This removes only the local Raft connection; it does not sign out Cursor CLI, delete the shared SDK login, or revoke a shared API key.",
        buttons: ["Cancel", "Disconnect"], defaultId: 0, cancelId: 0,
      });
      if (choice !== 1) return;
      await this.deps.disconnect();
      await this.deps.showMessage({ type: "info", title: "Cursor SDK", message: "Raft has been disconnected from Cursor." });
    } catch {
      await this.showFailure("Unable to disconnect Cursor. Stop active Cursor SDK Agents and retry. The shared Cursor login has not been removed.");
    }
  }

  private async showFailure(message: string): Promise<void> {
    try {
      await this.deps.showMessage({ type: "error", title: "Cursor SDK", message });
    } catch {
      // The window/app may already be closing; never surface raw provider errors.
    }
  }
}
