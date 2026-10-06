import {
  createUpgrader,
  fileProvenanceJournal,
  type CreateUpgraderOptions,
  type HostAdapter,
  type NotificationEvent,
  type ReleaseSource,
  type Upgrader,
} from "@botiverse/k-carrier";

import { createKHostAdapter } from "./kHostAdapter.js";
import { createKServiceExecutableSurface } from "./kLifecycleSurface.js";
import { kStateDir } from "./kPaths.js";
import { createComputerReleaseSource } from "./kReleaseSource.js";
import { resolveUpgradeBaseUrl, resolveUpgradeSourceForHome } from "./computerRelease.js";
import type { ReleaseBackend } from "./lib/releaseBackendState.js";

export interface CreateComputerUpgraderOptions {
  host?: HostAdapter;
  source?: ReleaseSource;
  baseUrl?: string;
  /** Release authority for the default source; callers that resolved the
   *  source for this home (resolveUpgradeSourceForHome) pass it through.
   *  Unset keeps the historical env-only resolution. */
  backend?: ReleaseBackend;
  notificationSink?: (event: NotificationEvent) => Promise<void>;
  onProgress?: CreateUpgraderOptions["onProgress"];
  lifecycleSurfaces?: NonNullable<CreateUpgraderOptions["lifecycleSurfaces"]>;
  createUpgraderFn?: typeof createUpgrader;
}

/**
 * The one Computer construction for K. CLI, live-service and recovery
 * coordinators vary only the requested operation/provenance; they never get a
 * second byte-swap path or a differently configured transaction engine.
 */
export function createComputerUpgrader(
  slockHome: string,
  opts: CreateComputerUpgraderOptions = {},
): Upgrader {
  const stateDir = kStateDir(slockHome);
  return (opts.createUpgraderFn ?? createUpgrader)({
    stateDir,
    host: opts.host ?? createKHostAdapter(slockHome),
    source: opts.source ?? createComputerReleaseSource(
      opts.baseUrl ?? resolveUpgradeBaseUrl(),
      { backend: opts.backend },
    ),
    policy: "confirm",
    notificationSink: opts.notificationSink ?? (async () => {}),
    onProgress: opts.onProgress,
    lifecycleSurfaces: opts.lifecycleSurfaces ?? [createKServiceExecutableSurface(slockHome)],
    provenance: fileProvenanceJournal(stateDir),
    provenanceIdentity: { who: "local", carrier: "computer" },
  });
}

/**
 * createComputerUpgrader with the release source resolved for this home via
 * resolveUpgradeSourceForHome (override > env > persisted state > private
 * default > hands). Executing paths (CLI upgrade, the __k-upgrade
 * coordinator, service upgrade start) use this; observe-only flows keep the
 * plain construction so a backend-selection error can never break journal
 * reads. Explicit source-shaping opts win over resolution.
 */
export async function createResolvedComputerUpgrader(
  slockHome: string,
  opts: CreateComputerUpgraderOptions = {},
): Promise<Upgrader> {
  if (opts.source || opts.baseUrl || opts.backend) return createComputerUpgrader(slockHome, opts);
  const { backend, baseUrl } = await resolveUpgradeSourceForHome(slockHome);
  return createComputerUpgrader(slockHome, { ...opts, baseUrl, backend });
}
