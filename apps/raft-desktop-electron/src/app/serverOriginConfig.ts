// Runtime server-origin configuration (private deployment phase 3-1).
//
// Splits two concepts the build previously conflated:
//   - isOfficialApiBuild() — BUILD identity (how this bundle was compiled);
//   - currentServerOrigin() — the deployment this boot actually talks to.
//
// Resolution order (PM-approved): userData/server-origin.json > the
// RAFT_DESKTOP_API_ORIGIN env > the baked CONFIGURED_API_ORIGIN. Both
// user-set layers run through the SAME validator — an env value gets no
// free pass over a disk one (PM review). A corrupt/invalid file or env
// value is ignored WITH a warning, falling back down the chain, so a bad
// value can never brick the app on boot.
//
// https-only, on purpose: the bundled renderer's stock CSP is
// `connect-src 'self' app: https: wss:` — an http origin (localhost
// included) cannot be reached without editing the shipped CSP, which the
// official-builds-stay-byte-identical rule forbids. http self-hosted
// origins remain a BUILD-time path (buildConfig.mjs CSP widening).
//
// The persisted `generation` is a monotonically increasing counter bumped
// on every override CHANGE (set to a different origin, or reset). It rides
// the preload-injected environment so the renderer's
// applyDesktopEnvironmentGeneration clears auth/session state whenever the
// deployment changes. Monotonicity across resets matters: if the counter
// ever regressed, a later switch could reuse a stored generation and skip
// the clearing — stale tokens from origin A would ride into origin B.

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIGURED_API_ORIGIN, OFFICIAL_API_ORIGINS } from "./configuredApiOrigin.js";

/** The env knob for CI/automation overrides (second priority). */
export const SERVER_ORIGIN_ENV = "RAFT_DESKTOP_API_ORIGIN";

/** File name inside userData holding the user's persisted override. */
export const SERVER_ORIGIN_FILE = "server-origin.json";

const MAX_ORIGIN_INPUT_LENGTH = 2048;

/**
 * Validate a runtime server-origin input. Returns the canonical origin
 * (scheme https, no credentials/query/hash/fragment, root path only) or
 * null. `javascript:`/`file:`/data: fall out at the scheme check; http is
 * rejected too (see the module comment — CSP).
 */
export function validateServerOriginInput(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ORIGIN_INPUT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export type ServerOriginSource = "file" | "env" | "none";

export interface ResolvedServerOrigin {
  /** The active override, or null when the build default applies. */
  readonly override: string | null;
  /** Which layer the override came from ("none" = no override). */
  readonly source: ServerOriginSource;
  /**
   * The generation injected for this boot. ≥1 whenever an override is
   * active (env-sourced overrides use 1 — they cannot have a file
   * generation, and the file layer outranks them, so 1 can never collide
   * with a file generation).
   */
  readonly generation: number;
  /** The last generation any file persisted (0 = never written). */
  readonly lastPersistedGeneration: number;
}

interface ServerOriginFile {
  origin?: unknown;
  generation?: unknown;
}

function parseFileGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 0;
}

/**
 * Resolve the boot-time override. Pure-ish (reads at most one small file);
 * deps are injected so tests and unusual runtimes can stub them.
 */
export function resolveServerOriginSync(
  userDataDir: string,
  deps: {
    env?: NodeJS.ProcessEnv;
    readFileSync?: (file: string) => string;
    log?: (message: string) => void;
  } = {},
): ResolvedServerOrigin {
  const log = deps.log ?? ((message: string) => console.warn(`[raft-desktop] ${message}`));
  const readFileSyncImpl = deps.readFileSync ?? ((file: string) => readFileSync(file, "utf8"));

  // Layer 1: the persisted user choice. Corrupt JSON, wrong shape or an
  // invalid origin is IGNORED with a warning (never bricks boot) — the env
  // and build defaults still apply.
  let fileGeneration = 0;
  let fileOverride: string | null = null;
  try {
    const raw = readFileSyncImpl(path.join(userDataDir, SERVER_ORIGIN_FILE));
    const parsed = JSON.parse(raw) as ServerOriginFile;
    fileGeneration = parseFileGeneration(parsed.generation);
    const validated = validateServerOriginInput(parsed.origin);
    if (typeof parsed.origin === "string" && parsed.origin !== "" && !validated) {
      log(`ignoring invalid server origin in ${SERVER_ORIGIN_FILE}: ${String(parsed.origin)}`);
    }
    fileOverride = validated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`ignoring unreadable ${SERVER_ORIGIN_FILE}: ${String(error instanceof Error ? error.message : error)}`);
    }
  }
  if (fileOverride !== null) {
    return { override: fileOverride, source: "file", generation: Math.max(fileGeneration, 1), lastPersistedGeneration: fileGeneration };
  }

  // Layer 2: env (CI/automation). Same validator, same ignore+warn rule.
  const envRaw = deps.env?.[SERVER_ORIGIN_ENV];
  if (typeof envRaw === "string" && envRaw.trim().length > 0) {
    const validated = validateServerOriginInput(envRaw);
    if (!validated) {
      log(`ignoring invalid ${SERVER_ORIGIN_ENV}: ${envRaw.trim()}`);
    } else {
      return { override: validated, source: "env", generation: 1, lastPersistedGeneration: fileGeneration };
    }
  }

  // Layer 3: the baked build default (no override).
  return { override: null, source: "none", generation: 0, lastPersistedGeneration: fileGeneration };
}

export type ServerOriginSetResult =
  | { ok: true; changed: boolean; generation: number; origin: string | null }
  | { ok: false; error: string };

export interface ServerOriginStatus {
  /** The origin this boot talks to (override ?? baked default). */
  origin: string;
  /** The persisted override, when one is active. */
  override: string | null;
  /** The build-time baked origin (never changes at runtime). */
  bakedOrigin: string;
  /** True when `origin` is an official backend origin. */
  isOfficial: boolean;
  /** The injection generation for this boot (0 = nothing injected). */
  generation: number;
}

/**
 * The boot-scoped server-origin state. Values are resolved ONCE per boot —
 * origin changes take effect after relaunch (the renderer's session
 * clearing and the main-process allowlists all depend on that), so
 * current()/isOfficial()/injectionGeneration() keep describing THIS boot
 * after a set/reset. The file write itself is tracked as `pending` so
 * status() can describe what the NEXT boot will use ("重启生效").
 */
export class ServerOriginConfig {
  private readonly userDataDir: string;
  private readonly resolved: ResolvedServerOrigin;
  /** Validated env override (status needs it after a reset un-hides it). */
  private readonly envOverride: string | null;
  private pending: { origin: string | null; generation: number } | null = null;
  /** High-water generation mark: the file's last value, advanced per write. */
  private lastGeneration: number;
  private readonly log: (message: string) => void;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: { userDataDir: string; env?: NodeJS.ProcessEnv; log?: (message: string) => void; resolved?: ResolvedServerOrigin }) {
    this.userDataDir = deps.userDataDir;
    this.log = deps.log ?? ((message: string) => console.warn(`[raft-desktop] ${message}`));
    this.resolved = deps.resolved ?? resolveServerOriginSync(deps.userDataDir, { env: deps.env, log: this.log });
    this.envOverride = this.resolved.source === "env"
      ? this.resolved.override
      : validateServerOriginInput(deps.env?.[SERVER_ORIGIN_ENV]);
    this.lastGeneration = this.resolved.lastPersistedGeneration;
  }

  /** The origin this boot talks to. */
  current(): string {
    return this.resolved.override ?? CONFIGURED_API_ORIGIN;
  }

  /** True when talking to an official backend this boot. */
  isOfficial(): boolean {
    return OFFICIAL_API_ORIGINS.has(this.current());
  }

  /** True when an override (file or env) is steering this boot. */
  hasOverride(): boolean {
    return this.resolved.override !== null;
  }

  /** The generation to inject into the renderer (0 = inject nothing). */
  injectionGeneration(): number {
    return this.resolved.override !== null ? this.resolved.generation : 0;
  }

  status(): ServerOriginStatus {
    // After a set/reset the file describes the NEXT boot; surface that (the
    // renderer's "saved — relaunch to apply" state) instead of this boot's
    // frozen resolution. current()/isOfficial() stay boot-true on purpose.
    const nextOverride = this.pending ? this.pending.origin : this.resolved.override;
    const effective = nextOverride ?? this.envOverride ?? CONFIGURED_API_ORIGIN;
    const generation = this.pending
      ? (this.pending.origin !== null || this.envOverride === null ? this.pending.generation : 1)
      : this.injectionGeneration();
    return {
      origin: effective,
      override: nextOverride ?? this.envOverride,
      bakedOrigin: CONFIGURED_API_ORIGIN,
      isOfficial: OFFICIAL_API_ORIGINS.has(effective),
      generation,
    };
  }

  /**
   * Validate and persist a new override (re-validated here in main — the
   * renderer's value is never trusted). Same-origin re-set is a no-op.
   * Changing the origin bumps the generation; the change takes effect on
   * the next launch.
   */
  set(raw: unknown): Promise<ServerOriginSetResult> {
    const canonical = validateServerOriginInput(raw);
    if (canonical === null) {
      return Promise.resolve({ ok: false, error: "invalid_server_origin" });
    }
    // No-op when the value matches what is (already) persisted — including a
    // value written earlier THIS session (pending), not just this boot's file.
    const persistedNow = this.pending ? this.pending.origin : this.resolved.override;
    if (canonical === persistedNow) {
      return Promise.resolve({
        ok: true,
        changed: false,
        generation: this.pending ? this.pending.generation : this.resolved.generation,
        origin: canonical,
      });
    }
    return this.enqueue(async () => {
      const generation = Math.max(this.lastGeneration, 1) + 1;
      await this.persist({ origin: canonical, generation });
      this.lastGeneration = generation;
      this.pending = { origin: canonical, generation };
      return { ok: true as const, changed: true, generation, origin: canonical };
    });
  }

  /**
   * Remove the persisted override (the env layer, if set, becomes active
   * again; otherwise the baked build default). Bumps the generation when
   * an override existed so a later override can never reuse a stored one.
   */
  reset(): Promise<ServerOriginSetResult> {
    const hadOverride = this.pending ? this.pending.origin !== null : this.resolved.source === "file";
    if (!hadOverride) {
      return Promise.resolve({ ok: true, changed: false, generation: this.resolved.generation, origin: null });
    }
    return this.enqueue(async () => {
      const generation = Math.max(this.lastGeneration, 1) + 1;
      await this.persist({ origin: null, generation });
      this.lastGeneration = generation;
      this.pending = { origin: null, generation };
      return { ok: true as const, changed: true, generation, origin: null };
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }

  // Write {origin (nullable), generation} atomically (tmp + rename), 0600.
  // The file is kept across resets (origin=null) so the generation counter
  // never regresses — see the module comment for why that matters.
  private async persist(value: { origin: string | null; generation: number }): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true });
    const file = path.join(this.userDataDir, SERVER_ORIGIN_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      `${JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(tmp, file);
  }
}
