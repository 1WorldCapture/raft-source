import { useState } from "react";
import CreateAgentDialog from "../components/agent/CreateAgentDialog";
import ServerCreatePreview from "../components/auth/ServerCreatePreview";
import ServerSetupComputerRuntimeStep from "../components/onboarding/ServerSetupComputerRuntimeStep";
import { useMachineStore } from "../store/machineStore";
import { readServerSetupPreviewView, serverSetupPreviewFixture } from "../dev/serverSetupPreviewFixtures";
import { computerInstallCommand } from "../utils/computerSetupCommand";
import { useDeploymentMode } from "../utils/deploymentMode";
import { getServerUrl } from "../utils/server";

const PREVIEW_MACHINE_TIMESTAMP = "2026-07-11T00:00:00.000Z";

function seedCreateAgentPreviewMachine() {
  useMachineStore.setState({
    machines: [{
      id: "preview-computer",
      name: "Wenyi's MacBook Pro",
      description: null,
      status: "online",
      statusVersion: 1,
      apiKeyPrefix: "preview",
      runtimes: ["claude", "builtin", "pi"],
      hostname: "wenyi-macbook-pro.local",
      os: "darwin arm64",
      daemonVersion: "preview",
      isComputer: true,
      computerAttachedByCurrentUser: true,
      computerVersion: "preview",
      computerUpgradeAvailable: false,
      lastHeartbeat: PREVIEW_MACHINE_TIMESTAMP,
      createdAt: PREVIEW_MACHINE_TIMESTAMP,
    }],
    loading: false,
  });
}

export default function ServerSetupComputerRuntimePreviewPage() {
  const initialView = readServerSetupPreviewView(window.location.search);
  const [view, setView] = useState(() => {
    if (initialView === "create-agent") {
      seedCreateAgentPreviewMachine();
    }
    return initialView;
  });
  const fixture = serverSetupPreviewFixture(view);
  const showCreateAgent = view === "create-agent";
  // Generated, not hardcoded (task #5): a private deployment renders the
  // install command from its own /downloads tree; the official default
  // renders the same string this page used to hardcode.
  const deploymentMode = useDeploymentMode();
  const installBase = deploymentMode === "private"
    ? `${getServerUrl().replace(/\/+$/, "")}/downloads/computer`
    : undefined;

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-brutal-cream font-display">
      <div className="absolute inset-0">
        <ServerCreatePreview serverName="Cindy's pricing team" serverSlug="cindys-pricing-team" />
      </div>
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
      <div className="absolute inset-0 flex items-center justify-center p-4 sm:px-8 sm:py-7 lg:px-[120px] lg:py-14">
        {showCreateAgent ? (
          <CreateAgentDialog
            onboarding
            onboardingShell="step"
            previewOnly
            previewRuntimeOptions={fixture.createRuntimeOptions}
            defaultMachineId="preview-computer"
            onClose={() => setView("ready")}
            onOnboardingStartOver={() => setView("offline-recovery")}
          />
        ) : (
          <ServerSetupComputerRuntimeStep
            key={view}
            computer={fixture.computer}
            runtimeStatus={fixture.runtimeStatus}
            runtimeOptions={fixture.runtimeOptions}
            hasConnectedComputer={fixture.hasConnectedComputer}
            offlineComputers={fixture.offlineComputers}
            serverSlug="launch"
            setupCommand="raft-computer setup /cindys-pricing-team"
            computerInstallCommand={computerInstallCommand(undefined, null, installBase)}
            macLinuxDaemonCommand="npx @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_preview0000000000000000"
            windowsDaemonCommand="npx.cmd @botiverse/raft-daemon@latest --server-url https://api.raft.build --api-key sk_machine_preview0000000000000000"
            onCopyInstallCommand={() => undefined}
            onOpenApiKeySettings={() => undefined}
            onNext={() => {
              seedCreateAgentPreviewMachine();
              setView("create-agent");
            }}
          />
        )}
      </div>
    </div>
  );
}
