// `raft-computer release-source show|init|set` — CLI presenters over the
// release-source state core (lib/releaseSource.ts, contract v1).
//
// The release source belongs to THIS Computer, not to any server connection:
//   show — read-only view of the effective source and where it came from;
//   init — installer/setup-time first-writer-wins initialization (used by
//          install.sh/ps1 after a verified install; refuses to switch an
//          existing different source);
//   set  — the ONLY deliberate migration/repair path for an existing Computer
//          (also repairs a corrupt file, which show/init treat as an error).
import { info, present } from "./output.js";
import {
  initializeReleaseSource,
  readReleaseSource,
  releaseSourcePath,
  resolveRuntimeReleaseSource,
  writeReleaseSource,
  type ReleaseBackend,
  type ReleaseSource,
} from "./lib/releaseSource.js";

export interface ReleaseSourceInput {
  backend: ReleaseBackend;
  releaseBase: string;
  handsOrigin?: string;
}

/** `release-source show` — effective source + provenance, read-only. */
export async function runReleaseSourceShow(slockHome: string): Promise<void> {
  await present(async () => {
    const resolved = await resolveRuntimeReleaseSource(process.env, slockHome);
    const originLabel =
      resolved.origin === "env-override" ? "environment override"
      : resolved.origin === "persisted" ? `persisted (${releaseSourcePath(slockHome)})`
      : "official default (no release-source file)";
    info(`backend:      ${resolved.source.backend}`);
    info(`release base: ${resolved.source.releaseBase}`);
    if (resolved.source.handsOrigin) info(`hands origin: ${resolved.source.handsOrigin}`);
    info(`source of truth: ${originLabel}`);
    if (resolved.origin === "official-default") {
      info("Run the private-deployment install command, or `release-source set`, to pin this Computer to a private source.");
    }
  });
}

/**
 * `release-source init` — first-writer-wins initialization for installers.
 * Idempotent for an equivalent existing source; a different existing source
 * is a conflict the installer must surface BEFORE replacing any binary or
 * state (contract: no silent takeover of an existing Computer).
 */
export async function runReleaseSourceInit(
  slockHome: string,
  input: ReleaseSourceInput,
  writtenBy = "installer",
): Promise<void> {
  await present(async () => {
    const source = toValidatedSource(input);
    const result = await initializeReleaseSource(slockHome, source, writtenBy);
    info(result.outcome === "initialized"
      ? `Release source initialized: ${source.backend} @ ${source.releaseBase}`
      : `Release source already ${source.backend} @ ${source.releaseBase}; left unchanged.`);
  });
}

/**
 * `release-source set` — deliberate migration or repair. Unlike init it
 * overwrites whatever is present (including a corrupt file — this is the
 * documented repair path) and prints what changed.
 */
export async function runReleaseSourceSet(
  slockHome: string,
  input: ReleaseSourceInput,
): Promise<void> {
  await present(async () => {
    const source = toValidatedSource(input);
    let previous: ReleaseSource | null = null;
    try {
      const existing = await readReleaseSource(slockHome);
      if (existing.status === "present") previous = existing.source;
    } catch {
      // Corrupt file: set is exactly the repair path; proceed to overwrite.
      info("Existing release-source file is unreadable; it will be replaced.");
    }
    await writeReleaseSource(slockHome, source, "release-source set");
    info(
      previous
        ? `Release source switched: ${previous.backend} @ ${previous.releaseBase} → ${source.backend} @ ${source.releaseBase}`
        : `Release source set: ${source.backend} @ ${source.releaseBase}`,
    );
    info("The next `raft-computer upgrade` and every service restart use this source.");
  });
}

/**
 * Validate presenter input into a full source. Kept here (not in the state
 * core) because CLI options arrive as raw strings and the error should read
 * like usage guidance.
 */
function toValidatedSource(input: ReleaseSourceInput): ReleaseSource {
  const backend: ReleaseBackend = input.backend;
  let releaseBase: string;
  try {
    releaseBase = new URL(input.releaseBase).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`--release-base must be a valid URL: ${input.releaseBase}`);
  }
  if (backend === "hands" && !input.handsOrigin) {
    throw new Error(`The hands backend requires --hands-origin (e.g. https://hands.build).`);
  }
  return {
    schemaVersion: 1,
    backend,
    releaseBase,
    ...(backend === "hands" && input.handsOrigin ? { handsOrigin: input.handsOrigin } : {}),
  };
}
