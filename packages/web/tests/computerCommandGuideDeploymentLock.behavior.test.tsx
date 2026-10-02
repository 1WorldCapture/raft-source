import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import ComputerCommandGuide from "../src/components/machine/ComputerCommandGuide";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => cleanup());

const render = (ui: React.ReactElement) => rtlRender(<TestIntlProvider>{ui}</TestIntlProvider>);

const READY_PROPS = {
  computerCommand: `raft-computer setup '/acme' --server-url 'https://raft.example.private'`,
  computerInstallCommand: `curl -fsSL 'https://raft.example.private/computer/install.sh' | RAFT_COMPUTER_INSTALL_CHANNEL='latest' sh`,
  macLinuxDaemonCommand: "npx @botiverse/raft-daemon@latest --api-key sk_machine_x",
  windowsDaemonCommand: "npx.cmd @botiverse/raft-daemon@latest --api-key sk_machine_x",
};

test("a non-ready deployment config replaces all commands with a visible error and no copy affordance", () => {
  render(
    <ComputerCommandGuide
      {...READY_PROPS}
      deploymentLockReason="This deployment's connect configuration is unavailable, so commands are disabled."
    />,
  );

  const error = screen.getByTestId("computer-guide-deployment-error");
  assert.match(error.textContent ?? "", /commands are disabled/);
  // Neither the Computer commands nor the daemon commands may render.
  assert.equal(screen.queryByText(READY_PROPS.computerCommand), null);
  assert.equal(screen.queryByText(READY_PROPS.computerInstallCommand), null);
  assert.equal(screen.queryByText(READY_PROPS.macLinuxDaemonCommand), null);
  assert.equal(screen.queryByRole("button", { name: /copy/i }), null);
});

test("while the deployment config loads the guide shows a preparing state without commands", () => {
  render(<ComputerCommandGuide {...READY_PROPS} deploymentLoading />);

  const loading = screen.getByTestId("computer-guide-deployment-loading");
  assert.match(loading.textContent ?? "", /Preparing this deployment's connect commands/);
  assert.equal(screen.queryByText(READY_PROPS.computerCommand), null);
  assert.equal(screen.queryByRole("button", { name: /copy/i }), null);
});

test("with the config ready the guide renders commands and copying works", async () => {
  const clipboardWrites: string[] = [];
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
  });
  try {
    render(<ComputerCommandGuide {...READY_PROPS} />);

    assert.ok(screen.getByText(READY_PROPS.computerInstallCommand));
    assert.ok(screen.getByText(READY_PROPS.computerCommand));
    assert.equal(screen.queryByTestId("computer-guide-deployment-loading"), null);
    assert.equal(screen.queryByTestId("computer-guide-deployment-error"), null);

    fireEvent.click(screen.getByRole("button", { name: "Copy 1. install command" }));
    await waitFor(() => assert.deepEqual(clipboardWrites, [READY_PROPS.computerInstallCommand]));
  } finally {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  }
});
