import { dialog, shell } from "electron";
import { createComputerApi } from "@botiverse/raft-computer/lib";
import { CursorSdkMenuController } from "../main/cursorSdkMenuController.js";

/** Native owner controls only: no renderer endpoint can acquire provider keys. */
export function createCursorSdkControls(getHome: () => string): CursorSdkMenuController {
  return new CursorSdkMenuController({
    status: async () => {
      const result = await createComputerApi(getHome()).cursorSdkStatus();
      const stateNames: Record<string, string> = {
        bound: "Saved connection", bound_stale_key: "Saved key changed; verification required",
        unbound: "Existing Cursor SDK login found", login_missing: "Sign-in required",
        invalid_store: "Local credential access requires attention", disconnected: "Disconnected",
      };
      return {
        state: stateNames[result.status] ?? "Unknown",
        detail: result.status === "bound"
          ? "This is the saved local connection status. Connect / Sign In → Use Existing Login verifies it online. No API key is displayed or sent to the Raft server."
          : "Use Connect / Sign In to reuse your existing Cursor SDK login or sign in through Cursor. Cursor CLI and Cursor SDK keep separate login stores.",
      };
    },
    connect: async ({ browser, signal, onLoginUrl }) => {
      const api = createComputerApi(getHome());
      if (browser) {
        await api.cursorSdkLogin((event) => {
          if (event.kind === "cursor-sdk.login-url") onLoginUrl(event.url);
        }, { signal });
      } else {
        await api.cursorSdkConnect({ signal });
      }
      return { state: "Verified and connected", detail: "Create an Agent using Cursor SDK on this computer. A server build that recognizes cursor-sdk is required. Existing Cursor CLI Agents are unchanged." };
    },
    disconnect: async () => { await createComputerApi(getHome()).cursorSdkLogout(); },
    showMessage: async (input) => (await dialog.showMessageBox({ ...input })).response,
    openExternal: async (url) => { await shell.openExternal(url); },
  });
}
