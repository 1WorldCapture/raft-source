// Task #5 (private deployment, phase 2) — PM review round 1 regression guard:
// while the deployment mode resolves (null), install-command surfaces render
// NO command at all; after a failed resolution ("unknown") they render the
// command together with a contact-admin notice — never a silent fallback to
// official CDN commands on a private server.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import ComputerCommandGuide from "../src/components/machine/ComputerCommandGuide";
import { computerInstallCommand } from "../src/utils/computerSetupCommand";
import { renderWithIntl } from "./helpers/intl";

const OFFICIAL_INSTALL = computerInstallCommand("production");
const SETUP = "raft-computer setup /acme";
const DAEMON = "npx @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_test";
const WINDOWS_DAEMON = "npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_test";

function renderGuide(deploymentMode: "private" | "standard" | "unknown" | null) {
  return renderWithIntl(
    <ComputerCommandGuide
      computerCommand={SETUP}
      computerInstallCommand={OFFICIAL_INSTALL}
      macLinuxDaemonCommand={DAEMON}
      windowsDaemonCommand={WINDOWS_DAEMON}
      deploymentMode={deploymentMode}
    />,
  );
}

afterEach(() => {
  cleanup();
});

test("loading mode renders no install/setup command — the official CDN command never flashes", () => {
  renderGuide(null);
  // The pending placeholder is shown instead of any Computer command.
  assert.ok(screen.getByTestId("computer-commands-pending"), "pending placeholder must render");
  // Neither the official install command nor the setup command may appear.
  assert.equal(screen.queryByText(OFFICIAL_INSTALL, { exact: true, selector: "code" }), null);
  assert.equal(screen.queryByText(SETUP, { exact: true, selector: "code" }), null);
  assert.equal(screen.queryByText(/cdn\.raft\.build/, { exact: false }), null);
});

test("unknown mode renders the commands with the contact-admin notice, not silently", () => {
  renderGuide("unknown");
  assert.ok(screen.getByText(OFFICIAL_INSTALL, { exact: true, selector: "code" }));
  assert.ok(screen.getByText(SETUP, { exact: true, selector: "code" }));
  assert.ok(screen.getByTestId("computer-commands-mode-unknown"), "notice must render");
  assert.equal(screen.queryByTestId("computer-commands-pending"), null);
});

test("resolved modes render commands without a notice", () => {
  renderGuide("standard");
  assert.ok(screen.getByText(OFFICIAL_INSTALL, { exact: true, selector: "code" }));
  assert.equal(screen.queryByTestId("computer-commands-mode-unknown"), null);
  assert.equal(screen.queryByTestId("computer-commands-pending"), null);
});

test("callers that pass no deploymentMode keep the historical behavior", () => {
  renderWithIntl(
    <ComputerCommandGuide
      computerCommand={SETUP}
      computerInstallCommand={OFFICIAL_INSTALL}
      macLinuxDaemonCommand={DAEMON}
      windowsDaemonCommand={WINDOWS_DAEMON}
    />,
  );
  assert.ok(screen.getByText(OFFICIAL_INSTALL, { exact: true, selector: "code" }));
  assert.equal(screen.queryByTestId("computer-commands-pending"), null);
  assert.equal(screen.queryByTestId("computer-commands-mode-unknown"), null);
});
