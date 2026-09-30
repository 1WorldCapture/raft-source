import type * as PiCodingAgentSdk from "@earendil-works/pi-coding-agent";
import type * as PiAiSdk from "@earendil-works/pi-ai";

/**
 * Version of `@earendil-works/pi-coding-agent` this daemon is built against.
 *
 * Runtime probes report it on every daemon start, and reading it from the SDK
 * would load ~110MB of modules on machines that never run a pi agent. The SDK is
 * pinned to an exact version in package.json, and `piSdk.test.ts` fails when
 * this constant and the installed SDK's own `VERSION` diverge, so a dependency
 * bump must update it.
 */
export const PI_SDK_VERSION = "0.85.1";

export type LoadedPiSdk = {
  codingAgent: typeof PiCodingAgentSdk;
  ai: typeof PiAiSdk;
};

let loaded: LoadedPiSdk | null = null;
let loading: Promise<LoadedPiSdk> | null = null;

/**
 * Import the pi SDKs on first use. Only runtime=pi/builtin agents (and model
 * detection for them) need it, so the daemon does not pay for it at startup.
 * A failed import is not cached: the next launch retries.
 */
export function loadPiSdk(): Promise<LoadedPiSdk> {
  loading ??= Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]).then(([codingAgent, ai]) => {
    loaded = { codingAgent, ai };
    return loaded;
  }, (error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** The SDKs if a pi session already loaded them, else null (never triggers a load). */
export function loadedPiSdk(): LoadedPiSdk | null {
  return loaded;
}

/** For code that can only run once a pi session exists (its SDK objects came from the loaded SDK). */
export function requireLoadedPiSdk(): LoadedPiSdk {
  if (!loaded) throw new Error("pi SDK is not loaded yet; call loadPiSdk() first");
  return loaded;
}
