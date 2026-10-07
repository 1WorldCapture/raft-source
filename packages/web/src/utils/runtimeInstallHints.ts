import { RUNTIMES, runtimeAvailabilitySuffix } from "@botiverse/raft-shared";
import type { MessageId } from "../i18n/messages/en";

export interface RuntimeInstallHint {
  introId: MessageId;
  /** Literal install commands (locale-independent shell). */
  commands: string[];
}

// Runtimes whose missing binary deserves an inline install hint next to the
// runtime picker. Availability gating comes from runtimeAvailabilitySuffix, so
// the hint appears exactly when the picker suffix says "(not installed)".
const RUNTIME_INSTALL_HINTS: Record<string, RuntimeInstallHint> = {
  omp: {
    introId: "runtime.installHint.omp",
    commands: [
      "curl -fsSL https://omp.sh/install | sh",
      "brew install can1357/tap/omp",
    ],
  },
};

export function runtimeInstallHintFor(
  runtimeId: string | null | undefined,
  machineRuntimeIds: readonly string[],
): RuntimeInstallHint | null {
  if (!runtimeId) return null;
  const hint = RUNTIME_INSTALL_HINTS[runtimeId];
  if (!hint) return null;
  const runtimeInfo = RUNTIMES.find((runtime) => runtime.id === runtimeId);
  if (!runtimeInfo) return null;
  return runtimeAvailabilitySuffix(runtimeInfo, machineRuntimeIds).kind === "notInstalled" ? hint : null;
}
