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
import { createRuntimeComputerReleaseSource, type KReleaseSourceDeps } from "./kReleaseSource.js";

export interface CreateComputerUpgraderOptions {
  host?: HostAdapter;
  source?: ReleaseSource;
  /** Deps seam for the default runtime release source (tests inject fetch/updater stubs). */
  releaseSourceDeps?: KReleaseSourceDeps;
  notificationSink?: (event: NotificationEvent) => Promise<void>;
  onProgress?: CreateUpgraderOptions["onProgress"];
  lifecycleSurfaces?: NonNullable<CreateUpgraderOptions["lifecycleSurfaces"]>;
  createUpgraderFn?: typeof createUpgrader;
}

/**
 * The one Computer construction for K. CLI, live-service and recovery
 * coordinators vary only the requested operation/provenance; they never get a
 * second byte-swap path or a differently configured transaction engine.
 *
 * The default release source is the RUNTIME release source (contract v1):
 * validated env group > persisted release-source.json > official default.
 * Every download/verify entry point that goes through this factory —
 * coordinator, recovery process, reconcile, CLI upgrade/rollback — therefore
 * consumes the same persisted private source after a restart. Inject
 * `source` only for locally staged artifacts (installer convergence) or tests.
 */
export function createComputerUpgrader(
  slockHome: string,
  opts: CreateComputerUpgraderOptions = {},
): Upgrader {
  const stateDir = kStateDir(slockHome);
  return (opts.createUpgraderFn ?? createUpgrader)({
    stateDir,
    host: opts.host ?? createKHostAdapter(slockHome),
    source: opts.source ?? createRuntimeComputerReleaseSource(slockHome, opts.releaseSourceDeps),
    policy: "confirm",
    notificationSink: opts.notificationSink ?? (async () => {}),
    onProgress: opts.onProgress,
    lifecycleSurfaces: opts.lifecycleSurfaces ?? [createKServiceExecutableSurface(slockHome)],
    provenance: fileProvenanceJournal(stateDir),
    provenanceIdentity: { who: "local", carrier: "computer" },
  });
}
