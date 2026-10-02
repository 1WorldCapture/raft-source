// Raft Computer release-source STATE (contract v1, task #6) — the pure
// parse/validate/read/write core for `<state-home>/computer/release-source.json`.
// Kept in lib/ next to channelState so the ComputerApi facade, the upgrade
// coordinator, and the service consume it without importing CLI presenters.
//
// The release source says WHERE this machine's single Computer binary and
// its updates come from. It belongs to the Computer itself — not to any one
// server connection — so `setup` may only initialize it when absent and a
// second server must never overwrite it (contract: multi-server boundary).
//
// Semantics that differ from channel state ON PURPOSE:
//   - Reading a PRESENT but corrupt/unreadable/unknown-schema file is an
//     ERROR, never a fallback to the official default. A machine whose
//     configured source is broken must fail visibly rather than silently
//     phone the official CDN (contract: no official fallback).
//   - Only a MISSING file means "old official install": the official default
//     then applies until the first private onboarding persists a source.
//
// Audit fields (writtenAt/writtenBy) are informational and deliberately
// excluded from source equivalence.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { computerDir } from "../paths.js";
import { writeDurableTextFile } from "../durableFile.js";
import { ComputerError } from "./errors.js";
import { DEFAULT_UPGRADE_BASE_URL } from "../computerRelease.js";
import { HANDS_API_ORIGIN } from "../releaseAuthority.js";

export const RELEASE_SOURCE_SCHEMA_VERSION = 1;

export type ReleaseBackend = "hands" | "manifest";

/** The release source itself — audit fields excluded (see PersistedReleaseSource). */
export interface ReleaseSource {
  schemaVersion: typeof RELEASE_SOURCE_SCHEMA_VERSION;
  backend: ReleaseBackend;
  /** Release file root; may contain a path, trailing slashes normalized away. */
  releaseBase: string;
  /** Version authority origin — REQUIRED for the hands backend, unused for manifest. */
  handsOrigin?: string;
}

/** On-disk form; writtenAt/writtenBy are audit-only and never affect equality. */
export interface PersistedReleaseSource extends ReleaseSource {
  writtenAt?: string;
  writtenBy?: string;
}

export function releaseSourcePath(slockHome: string): string {
  return path.join(computerDir(slockHome), "release-source.json");
}

/** The official default source a file-less (pre-contract) install represents. */
export function officialReleaseSource(): ReleaseSource {
  return {
    schemaVersion: RELEASE_SOURCE_SCHEMA_VERSION,
    backend: "hands",
    releaseBase: DEFAULT_UPGRADE_BASE_URL,
    handsOrigin: HANDS_API_ORIGIN,
  };
}

// --- URL validation (mirrors the server-side config group rules) ---

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function parseConfiguredUrl(raw: string): { origin: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.protocol !== "https:" && !isLoopbackHostname(parsed.hostname)) return null;
  return { origin: parsed.origin, path: parsed.pathname };
}

function parseOriginValue(raw: string): string | null {
  const parsed = parseConfiguredUrl(raw);
  if (!parsed) return null;
  if (parsed.path && parsed.path !== "/") return null;
  return parsed.origin;
}

function parseReleaseBaseValue(raw: string): string | null {
  const parsed = parseConfiguredUrl(raw);
  if (!parsed) return null;
  return `${parsed.origin}${parsed.path}`.replace(/\/+$/, "");
}

/**
 * Strict parse of a release-source JSON document. Returns null for anything
 * that is not a fully valid v1 source — the caller decides whether that is
 * "corrupt" (file present) or merely unusable input.
 */
export function parseReleaseSource(raw: string): PersistedReleaseSource | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.schemaVersion !== RELEASE_SOURCE_SCHEMA_VERSION) return null;
  if (body.backend !== "hands" && body.backend !== "manifest") return null;

  const releaseBase = typeof body.releaseBase === "string" ? parseReleaseBaseValue(body.releaseBase) : null;
  if (!releaseBase) return null;

  let handsOrigin: string | undefined;
  if (body.backend === "hands") {
    if (typeof body.handsOrigin !== "string") return null;
    const parsed = parseOriginValue(body.handsOrigin);
    if (!parsed) return null;
    handsOrigin = parsed;
  } else if (body.handsOrigin !== undefined) {
    // manifest never reads this field; storing it would misrepresent intent.
    return null;
  }

  return {
    schemaVersion: RELEASE_SOURCE_SCHEMA_VERSION,
    backend: body.backend,
    releaseBase,
    ...(handsOrigin !== undefined ? { handsOrigin } : {}),
    ...(typeof body.writtenAt === "string" ? { writtenAt: body.writtenAt } : {}),
    ...(typeof body.writtenBy === "string" ? { writtenBy: body.writtenBy } : {}),
  };
}

/** Semantic equality: same backend, releaseBase, and (for hands) handsOrigin. */
export function releaseSourcesEquivalent(a: ReleaseSource, b: ReleaseSource): boolean {
  return a.backend === b.backend
    && a.releaseBase === b.releaseBase
    && (a.backend === "hands" ? a.handsOrigin === b.handsOrigin : true);
}

export type ReadReleaseSourceResult =
  | { status: "present"; source: PersistedReleaseSource }
  | { status: "absent" };

/**
 * Read the persisted release source. A missing file is a legitimate state
 * (old official install); a present but corrupt/unreadable file is a hard
 * error — the caller must surface it, never fall back to the official
 * default (contract).
 */
export async function readReleaseSource(slockHome: string): Promise<ReadReleaseSourceResult> {
  let raw: string;
  try {
    raw = await readFile(releaseSourcePath(slockHome), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    throw new ComputerError(
      "RELEASE_SOURCE_UNREADABLE",
      `The release source at ${releaseSourcePath(slockHome)} could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const parsed = parseReleaseSource(raw);
  if (!parsed) {
    throw new ComputerError(
      "RELEASE_SOURCE_CORRUPT",
      `The release source at ${releaseSourcePath(slockHome)} is corrupt or uses an unknown schema. Refusing to fall back to the official source — repair it with \`raft-computer release-source set\`.`,
    );
  }
  return { status: "present", source: parsed };
}

/**
 * Validate and atomically persist a release source (durable write + readback,
 * mode 0600). The caller supplies the actor identity for the audit fields;
 * audit fields never participate in equivalence.
 */
export async function writeReleaseSource(
  slockHome: string,
  source: ReleaseSource,
  writtenBy: string,
): Promise<void> {
  const document: PersistedReleaseSource = {
    ...source,
    writtenAt: new Date().toISOString(),
    writtenBy,
  };
  // Round-trip through the strict parser: what goes to disk must read back
  // as a fully valid source.
  const serialized = JSON.stringify(document, null, 2) + "\n";
  if (!parseReleaseSource(serialized)) {
    throw new ComputerError(
      "RELEASE_SOURCE_INVALID",
      "The supplied release source failed validation and was not written.",
    );
  }
  await writeDurableTextFile(releaseSourcePath(slockHome), serialized);
}

/**
 * Initialize the release source for a machine that has none. Idempotent for
 * an equivalent existing source; a DIFFERENT existing source is a conflict
 * that must be resolved explicitly (installer/setup never overwrite it).
 */
export async function initializeReleaseSource(
  slockHome: string,
  source: ReleaseSource,
  writtenBy: string,
): Promise<{ outcome: "initialized" } | { outcome: "already-present" }> {
  const existing = await readReleaseSource(slockHome);
  if (existing.status === "present") {
    if (releaseSourcesEquivalent(existing.source, source)) return { outcome: "already-present" };
    throw new ComputerError(
      "RELEASE_SOURCE_CONFLICT",
      `This Computer already tracks releases from ${existing.source.releaseBase} (${existing.source.backend}). Refusing to switch to ${source.releaseBase} (${source.backend}) implicitly — run \`raft-computer release-source set\` to migrate deliberately.`,
    );
  }
  await writeReleaseSource(slockHome, source, writtenBy);
  return { outcome: "initialized" };
}

// --- runtime resolution: env debug override > persisted file > official default ---

export const RAFT_COMPUTER_RELEASE_BASE_ENV = "RAFT_COMPUTER_RELEASE_BASE";
export const RAFT_COMPUTER_RELEASE_BACKEND_ENV = "RAFT_COMPUTER_RELEASE_BACKEND";
export const RAFT_COMPUTER_HANDS_ORIGIN_ENV = "RAFT_COMPUTER_HANDS_ORIGIN";
/** Legacy pre-contract updater variable; normalized into the new group. */
export const RAFT_COMPUTER_UPGRADE_BASE_URL_ENV = "RAFT_COMPUTER_UPGRADE_BASE_URL";
/** Legacy pre-contract backend value; normalized to the manifest backend. */
export const LEGACY_RELEASE_BACKEND_VALUE = "legacy-cdn";

export interface ResolvedRuntimeReleaseSource {
  source: ReleaseSource;
  origin: "env-override" | "persisted" | "official-default";
}

function trimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
  return typeof env[key] === "string" ? (env[key] as string).trim() : "";
}

/**
 * Resolve the effective release source for the CLI, the resident service,
 * and the upgrade coordinator — the ONE precedence chain they must all share
 * (contract): validated env debug override, then the persisted file, then
 * the official default. The env override is a COMPLETE group (no per-field
 * mixing with file/default values) and rejects conflicts with the legacy
 * variable names instead of guessing which one wins.
 */
export async function resolveRuntimeReleaseSource(
  env: NodeJS.ProcessEnv = process.env,
  slockHome: string,
): Promise<ResolvedRuntimeReleaseSource> {
  const newBase = trimmedEnv(env, RAFT_COMPUTER_RELEASE_BASE_ENV);
  const rawBackend = trimmedEnv(env, RAFT_COMPUTER_RELEASE_BACKEND_ENV);
  const handsOriginRaw = trimmedEnv(env, RAFT_COMPUTER_HANDS_ORIGIN_ENV);
  const legacyBase = trimmedEnv(env, RAFT_COMPUTER_UPGRADE_BASE_URL_ENV);
  const anyEnvSet = Boolean(newBase || rawBackend || handsOriginRaw || legacyBase);

  if (anyEnvSet) {
    if (newBase && legacyBase && newBase !== legacyBase) {
      throw new ComputerError(
        "RELEASE_SOURCE_ENV_CONFLICT",
        `${RAFT_COMPUTER_RELEASE_BASE_ENV} and ${RAFT_COMPUTER_UPGRADE_BASE_URL_ENV} are both set but differ (${newBase} vs ${legacyBase}). Keep exactly one.`,
      );
    }
    const releaseBaseRaw = newBase || legacyBase;
    if (!releaseBaseRaw) {
      throw new ComputerError(
        "RELEASE_SOURCE_ENV_INVALID",
        `A release-source environment override is set but ${RAFT_COMPUTER_RELEASE_BASE_ENV} is missing.`,
      );
    }
    const releaseBase = parseReleaseBaseValue(releaseBaseRaw);
    if (!releaseBase) {
      throw new ComputerError(
        "RELEASE_SOURCE_ENV_INVALID",
        `${RAFT_COMPUTER_RELEASE_BASE_ENV} must be an http(s) URL without credentials, query, or fragment (HTTPS unless loopback): ${releaseBaseRaw}`,
      );
    }

    // legacy-cdn is the pre-contract name for the self-manifest backend.
    const backend: ReleaseBackend | null =
      !rawBackend || rawBackend === "hands" ? "hands"
      : rawBackend === "manifest" || rawBackend === LEGACY_RELEASE_BACKEND_VALUE ? "manifest"
      : null;
    if (!backend) {
      throw new ComputerError(
        "RELEASE_SOURCE_ENV_INVALID",
        `${RAFT_COMPUTER_RELEASE_BACKEND_ENV} must be "hands" or "manifest" (legacy "legacy-cdn" maps to manifest): ${rawBackend}`,
      );
    }

    let handsOrigin: string | undefined;
    if (backend === "hands") {
      const parsed = handsOriginRaw ? parseOriginValue(handsOriginRaw) : null;
      if (!parsed) {
        throw new ComputerError(
          "RELEASE_SOURCE_ENV_INVALID",
          `The hands backend requires ${RAFT_COMPUTER_HANDS_ORIGIN_ENV} to be set (origin-only http(s) URL) alongside the override.`,
        );
      }
      handsOrigin = parsed;
    } else if (handsOriginRaw) {
      throw new ComputerError(
        "RELEASE_SOURCE_ENV_INVALID",
        `${RAFT_COMPUTER_HANDS_ORIGIN_ENV} is set but the backend is "manifest", which never uses it.`,
      );
    }

    return {
      source: {
        schemaVersion: RELEASE_SOURCE_SCHEMA_VERSION,
        backend,
        releaseBase,
        ...(handsOrigin !== undefined ? { handsOrigin } : {}),
      },
      origin: "env-override",
    };
  }

  const persisted = await readReleaseSource(slockHome);
  if (persisted.status === "present") {
    return {
      source: {
        schemaVersion: persisted.source.schemaVersion,
        backend: persisted.source.backend,
        releaseBase: persisted.source.releaseBase,
        ...(persisted.source.handsOrigin !== undefined ? { handsOrigin: persisted.source.handsOrigin } : {}),
      },
      origin: "persisted",
    };
  }
  return { source: officialReleaseSource(), origin: "official-default" };
}
