// Private-deployment update checker (phase 3-2).
//
// macOS auto-update via Squirrel.Mac REQUIRES a signed app — verified on
// this machine with a minimal unsigned build (download + sha512 pass, then
// ShipIt rejects: "Code signature … did not pass validation"; matches the
// official Electron docs). Private builds are unsigned, so the private
// path is detect → notify → the user installs manually:
//
//   main fetches `${origin}/downloads/desktop/latest-mac.yml`, compares
//   versions, and exposes a small status stream. The renderer surfaces a
//   top-bar pill; clicking asks MAIN to open the download (the URL never
//   reaches openExternal from the renderer, and it must survive strict
//   same-origin validation first — a tampered feed must not be able to
//   steer users to an external site).
//
// Official builds never start this module (app/index.ts gates on the
// runtime server origin) — their updater path is byte-identical to before.
// The feed format is electron-builder's generic-provider latest-mac.yml so
// a future signed private build can switch to in-place updates against the
// same URLs without server-side changes.

export type PrivateUpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; size?: number }
  | { state: "none" };

export interface PrivateUpdateInfo {
  readonly version: string;
  readonly downloadUrl: string;
  readonly size?: number;
}

export interface PrivateUpdateDeps {
  /** The current private server origin (https, boot-stable). */
  origin: string;
  /** This app's version (app.getVersion()). */
  appVersion: string;
  /** Opens the download in the system browser (electron shell.openExternal). */
  openExternal: (url: string) => void | Promise<void>;
  /** This machine's electron arch (process.arch; injected for tests). */
  arch?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** First check delay + re-check interval. */
  initialDelayMs?: number;
  intervalMs?: number;
}

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_YML_BYTES = 64 * 1024;

function strictSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a strictly newer plain semver than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = strictSemver(candidate);
  const b = strictSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

/**
 * Minimal strict parser for the fields we consume from a generic-provider
 * latest-mac.yml: the top-level `version:` and every `url:` (+ its optional
 * `size:`) under `files:`. Dual-arch trees list zip AND dmg for BOTH
 * architectures — the artifact for THIS machine is selected by the caller
 * (`.dmg` ending on the current arch). Returns null when the version is
 * missing or not a strict triple, or when no file entries exist; unknown
 * extra fields are ignored (the file is authored by electron-builder and
 * carries more than we need).
 */
export function parseLatestMacYml(text: string): { version: string; files: Array<{ url: string; size?: number }> } | null {
  const lines = text.split(/\r?\n/);
  let version: string | null = null;
  const files: Array<{ url: string; size?: number }> = [];
  let inFiles = false;
  let current: { url: string; size?: number } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    if (/^files:/.test(line)) {
      inFiles = true;
      continue;
    }
    if (/^\S/.test(line)) inFiles = false; // any top-level key ends the block
    if (!inFiles) {
      const versionMatch = /^version:\s*(\S+)\s*$/.exec(line);
      if (versionMatch) version = versionMatch[1]!;
      continue;
    }
    const urlMatch = /^\s+-\s+url:\s*(\S+)\s*$/.exec(line) || /^\s+url:\s*(\S+)\s*$/.exec(line);
    if (urlMatch) {
      current = { url: urlMatch[1]! };
      files.push(current);
      continue;
    }
    const sizeMatch = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (sizeMatch && current) current.size = Number(sizeMatch[1]);
  }
  if (!version || files.length === 0) return null;
  if (!strictSemver(version)) return null;
  return { version, files };
}

/**
 * The manual-install artifact for THIS machine: the `.dmg` entry whose name
 * ends in `-${arch}.dmg` (electron-builder's artifactName is
 * `Raft-Desktop-${version}-${arch}.${ext}`); when the feed carries no dmg for
 * this arch (zip-only feeds), the `-${arch}.zip` instead. Other architectures
 * are always ignored; with neither there is nothing to prompt about.
 */
export function selectDownloadFile(
  files: ReadonlyArray<{ url: string; size?: number }>,
  arch: string,
): { url: string; size?: number } | null {
  return (
    files.find((file) => file.url.endsWith(`-${arch}.dmg`)) ??
    files.find((file) => file.url.endsWith(`-${arch}.zip`) || file.url.endsWith(`-${arch}-mac.zip`)) ??
    null
  );
}

/**
 * Resolve the feed's file reference against the downloads base and enforce
 * the safety invariants (PM review): the result must be an https URL on
 * EXACTLY the current server origin — a tampered feed carrying an absolute
 * URL, a scheme upgrade, or a look-alike host yields null (discard + warn),
 * never a user-visible link.
 */
export function resolvePrivateDownloadUrl(origin: string, fileUrl: string, log: (message: string) => void): string | null {
  let resolved: URL;
  try {
    resolved = new URL(fileUrl, `${origin.replace(/\/+$/, "")}/downloads/desktop/`);
  } catch {
    log(`discarding unparseable private update file url: ${fileUrl}`);
    return null;
  }
  if (resolved.username || resolved.password || resolved.search || resolved.hash) {
    log(`discarding private update url with credentials/query/fragment: ${resolved.href}`);
    return null;
  }
  const originUrl = new URL(origin);
  if (resolved.protocol !== "https:" || resolved.origin !== originUrl.origin) {
    log(`discarding private update url outside the current origin: ${resolved.href} (origin: ${origin})`);
    return null;
  }
  return resolved.href;
}

/**
 * Start the checker. Returns the surface app/index.ts wires into IPC; the
 * validated download URL lives ONLY here (main) — the renderer gets the
 * version and asks main to open the download.
 */
export function startPrivateUpdateChecker(deps: PrivateUpdateDeps): {
  check(): Promise<void>;
  status(): PrivateUpdateStatus;
  onStatus(listener: (status: PrivateUpdateStatus) => void): () => void;
  openDownload(): boolean;
  currentInfo(): PrivateUpdateInfo | null;
} {
  const log = deps.log ?? ((message: string) => console.warn(`[raft-desktop] ${message}`));
  const fetchImpl = deps.fetchImpl ?? fetch;
  let current: PrivateUpdateStatus = { state: "idle" };
  let info: PrivateUpdateInfo | null = null;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<(status: PrivateUpdateStatus) => void>();

  const setStatus = (status: PrivateUpdateStatus): void => {
    current = status;
    // A later check that lands on none/failure invalidates the previous
    // artifact — openDownload must never outlive the visible state.
    if (status.state !== "available") info = null;
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // a bad listener must not break the checker
      }
    }
  };

  async function checkInternal(): Promise<void> {
    setStatus({ state: "checking" });
    let text: string;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${deps.origin.replace(/\/+$/, "")}/downloads/desktop/latest-mac.yml`, {
          signal: controller.signal,
          headers: { accept: "text/yaml, text/plain, */*" },
        });
        if (!response.ok) {
          // 404 = the deployment does not publish desktop artifacts yet —
          // the ordinary pre-task-#12 state; stay quiet, not an error.
          setStatus({ state: "none" });
          return;
        }
        const raw = await response.text();
        if (raw.length > MAX_YML_BYTES) throw new Error(`latest-mac.yml too large (${raw.length} bytes)`);
        text = raw;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Network failure is routine (offline laptop): retry at the next tick.
      setStatus({ state: "none" });
      return;
    }
    const parsed = parseLatestMacYml(text);
    if (!parsed) {
      log("discarding malformed private latest-mac.yml");
      setStatus({ state: "none" });
      return;
    }
    const artifact = selectDownloadFile(parsed.files, deps.arch ?? process.arch);
    if (!artifact) {
      // Nothing installable for this machine (zips only / other arch):
      // never steer the user at the wrong package.
      log(`no ${deps.arch ?? process.arch} dmg or zip in private latest-mac.yml`);
      setStatus({ state: "none" });
      return;
    }
    const downloadUrl = resolvePrivateDownloadUrl(deps.origin, artifact.url, log);
    if (!downloadUrl) {
      setStatus({ state: "none" });
      return;
    }
    if (!isNewerVersion(parsed.version, deps.appVersion)) {
      setStatus({ state: "none" });
      return;
    }
    info = { version: parsed.version, downloadUrl, ...(artifact.size !== undefined ? { size: artifact.size } : {}) };
    setStatus({ state: "available", version: parsed.version, ...(artifact.size !== undefined ? { size: artifact.size } : {}) });
  }

  // unref: the schedule must never hold the process open by itself (it is a
  // courtesy re-check, not a lifecycle owner).
  const schedule = (delayMs: number): void => {
    const timer = setTimeout(() => {
      void checkInternal().finally(() => schedule(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
    }, delayMs);
    timer.unref?.();
  };
  schedule(deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);

  return {
    check(): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = checkInternal().finally(() => { inFlight = null; });
      return inFlight;
    },
    status(): PrivateUpdateStatus {
      return current;
    },
    onStatus(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openDownload(): boolean {
      if (!info) return false;
      // The validated URL is opened from main only — the renderer never
      // receives it, so it cannot smuggle an arbitrary URL into
      // shell.openExternal through this surface.
      void Promise.resolve(deps.openExternal(info.downloadUrl)).catch(() => {});
      return true;
    },
    currentInfo(): PrivateUpdateInfo | null {
      return info;
    },
  };
}
