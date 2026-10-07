import type { DaemonCoreOptions } from "@botiverse/raft-daemon/core";
import { DEFAULT_COMPUTER_HOST_KIND, type ComputerHostKind } from "@botiverse/raft-shared";
import { BUNDLED_DAEMON_VERSION, COMPUTER_VERSION } from "./version.js";

export interface ResidentCoreIdentityCredentials {
  serverId: string;
  serverMachineId: string;
  apiKey: string;
  serverUrl: string;
  /** Set by the host adapter that embeds the Computer (e.g. the desktop app). */
  hostKind?: ComputerHostKind;
}

export function residentCoreIdentity(
  creds: ResidentCoreIdentityCredentials,
): Pick<
  DaemonCoreOptions,
  "serverUrl" | "apiKey" | "machineOwnerProvenance" | "daemonVersion" | "computerVersion" | "computerHostKind"
> {
  return {
    serverUrl: creds.serverUrl,
    apiKey: creds.apiKey,
    machineOwnerProvenance: {
      kind: "managed_computer_runner",
      serverId: creds.serverId,
      serverMachineId: creds.serverMachineId,
    },
    daemonVersion: BUNDLED_DAEMON_VERSION,
    computerVersion: COMPUTER_VERSION,
    computerHostKind: creds.hostKind ?? DEFAULT_COMPUTER_HOST_KIND,
  };
}
