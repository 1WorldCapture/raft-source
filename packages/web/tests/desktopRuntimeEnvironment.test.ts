import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
  absoluteApiBase,
  applyDesktopEnvironmentGeneration,
  assertValidDesktopRuntimeEnvironment,
  deriveRuntimeEndpoints,
  hasDesktopBridge,
  readDesktopRuntimeEnvironment,
} from "../src/desktopRuntimeEnvironment";

const production = {
  environmentId: "production",
  generation: 4,
  frontendOrigin: "https://app.raft.build",
  apiOrigin: "https://api.raft.build",
  socketOrigin: "https://api.raft.build",
  updateAuthority: "productionHands",
} as const;

const staging = {
  environmentId: "staging",
  generation: 4,
  frontendOrigin: "https://raft-app-staging.botiverse.dev",
  apiOrigin: "https://api-aws-staging.botiverse.dev",
  socketOrigin: "https://api-aws-staging.botiverse.dev",
  updateAuthority: "none",
} as const;

function withoutKey<T extends Record<string, unknown>>(value: T, key: keyof T): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function maskCommentsAndStrings(source: string): string {
  let masked = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      masked += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        masked += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      masked += "  ";
      index += 2;
      while (index < source.length) {
        const current = source[index]!;
        const following = source[index + 1];
        masked += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === "*" && following === "/") {
          masked += " ";
          index += 1;
          break;
        }
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      masked += " ";
      index += 1;
      while (index < source.length) {
        const current = source[index]!;
        masked += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === "\\") {
          if (index < source.length) {
            masked += source[index] === "\n" ? "\n" : " ";
            index += 1;
          }
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    masked += char;
    index += 1;
  }
  return masked;
}

function realGuardCallIndexes(source: string): number[] {
  const masked = maskCommentsAndStrings(source);
  return Array.from(masked.matchAll(/(?<![.$\w])assertValidDesktopRuntimeEnvironment\s*\(\s*\)/g)).map((match) => match.index ?? -1);
}

function literalIndexes(source: string, literal: string): number[] {
  const indexes: number[] = [];
  let index = source.indexOf(literal);
  while (index >= 0) {
    indexes.push(index);
    index = source.indexOf(literal, index + literal.length);
  }
  return indexes;
}

function assertGuardBeforeSinks(file: string, sinks: string[], expectedCallCount: number, options?: { pairCallsWithSinks?: boolean }): void {
  const root = resolve(import.meta.dirname, "..");
  const source = readFileSync(resolve(root, file), "utf8");
  const masked = maskCommentsAndStrings(source);
  const callIndexes = realGuardCallIndexes(source);

  assert.match(source, /desktopRuntimeEnvironment/, `${file} must import the runtime module`);
  assert.equal(callIndexes.length, expectedCallCount, `${file} must contain real guard calls only`);
  assert.doesNotMatch(source, /VITE_API_URL/, `${file} must not read VITE_API_URL directly`);

  for (const sink of sinks) {
    const sinkIndexes = literalIndexes(masked, sink);
    assert.ok(sinkIndexes.length > 0, `${file} must contain sink ${sink}`);
    for (const sinkIndex of sinkIndexes) {
      assert.ok(
        callIndexes.some((callIndex) => callIndex >= 0 && callIndex < sinkIndex),
        `${file} must call assertValidDesktopRuntimeEnvironment() before ${sink}`,
      );
    }
    if (options?.pairCallsWithSinks) {
      assert.equal(sinkIndexes.length, callIndexes.length, `${file} must pair every ${sink} sink with a guard call`);
      for (let index = 0; index < sinkIndexes.length; index += 1) {
        assert.ok(callIndexes[index]! < sinkIndexes[index]!, `${file} guard call ${index + 1} must precede ${sink} ${index + 1}`);
        if (index > 0) {
          assert.ok(callIndexes[index]! > sinkIndexes[index - 1]!, `${file} guard call ${index + 1} must be local to ${sink} ${index + 1}`);
        }
      }
    }
  }
}

describe("native Desktop runtime environment", () => {
  test("accepts only built-in production and staging exact tuples", () => {
    assert.deepEqual(readDesktopRuntimeEnvironment({ __RAFT_DESKTOP_ENVIRONMENT__: production }), production);
    assert.deepEqual(readDesktopRuntimeEnvironment({ __RAFT_DESKTOP_ENVIRONMENT__: staging }), staging);
  });

  test("rejects missing, extra, malformed, wrong-host, and cross-paired tuples", () => {
    for (const invalid of [
      withoutKey(production, "apiOrigin"),
      { ...production, customUrl: "https://evil.test" },
      { ...production, environmentId: "custom" },
      { ...production, apiOrigin: "" },
      { ...production, apiOrigin: "http://api.raft.build" },
      { ...production, apiOrigin: "https://api.raft.build/path" },
      { ...production, apiOrigin: "https://api.raft.build?x=1" },
      { ...production, socketOrigin: "https://api.raft.build#hash" },
      { ...production, frontendOrigin: staging.frontendOrigin },
      { ...production, apiOrigin: staging.apiOrigin },
      { ...production, socketOrigin: staging.socketOrigin },
      { ...staging, frontendOrigin: production.frontendOrigin },
      { ...staging, apiOrigin: "https://raft-app-staging.botiverse.dev" },
      { ...staging, socketOrigin: production.socketOrigin },
      { ...staging, updateAuthority: "productionHands" },
    ]) {
      assert.equal(readDesktopRuntimeEnvironment({ __RAFT_DESKTOP_ENVIRONMENT__: invalid }), null);
    }
  });

  test("generation changes clear auth storage and every cache exactly once", async () => {
    const values = new Map<string, string>([["token", "secret"], ["raft_desktop_environment_generation", "3"]]);
    let clears = 0;
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      clear: () => { clears += 1; values.clear(); },
    };
    const deleted: string[] = [];
    const cacheStorage = {
      keys: async () => ["auth", "assets"],
      delete: async (key: string) => { deleted.push(key); return true; },
    };
    assert.equal(applyDesktopEnvironmentGeneration(production, storage, cacheStorage), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(clears, 1);
    assert.deepEqual(deleted.sort(), ["assets", "auth"]);
    // Composite marker (PM review, phase 3-1): origin # generation.
    assert.equal(values.get("raft_desktop_environment_generation"), "https://api.raft.build#4");
    assert.equal(applyDesktopEnvironmentGeneration(production, storage, cacheStorage), false);
    assert.equal(clears, 1);
  });

  test("legacy bare-generation markers still match preset environments (no logout on upgrade)", () => {
    const values = new Map<string, string>([["raft_desktop_environment_generation", "4"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      clear: () => { values.clear(); },
    };
    // A pre-composite Tauri boot stored "4"; the same production generation
    // must NOT clear, and migrates the marker to composite form.
    assert.equal(applyDesktopEnvironmentGeneration(production, storage), false);
    assert.equal(values.get("raft_desktop_environment_generation"), "4");
  });

  test("browser mode has no destructive side effect", () => {
    let clears = 0;
    const storage = { getItem: () => null, setItem: () => {}, clear: () => { clears += 1; } };
    assert.equal(applyDesktopEnvironmentGeneration(null, storage), false);
    assert.equal(clears, 0);
  });

  // ── composite-marker switch semantics (PM review, phase 3-1) ────────────

  function environmentFor(origin: string, generation = 1) {
    // Read a real "server" environment through the public parser so the
    // marker semantics are exercised against validated tuples.
    return readDesktopRuntimeEnvironment({
      __RAFT_DESKTOP_ENVIRONMENT__: { apiOrigin: origin, socketOrigin: origin, generation },
    });
  }

  function markerStorage(initial?: [string, string]) {
    const values = new Map<string, string>(initial ? [initial] : []);
    let clears = 0;
    return {
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        clear: () => { clears += 1; values.clear(); },
      },
      values,
      clears: () => clears,
    };
  }

  test("private → reset → official clears (no private tokens ride into the official backend)", () => {
    const env = environmentFor("https://raft.internal.example:8443", 2);
    assert.ok(env);
    const { storage, values, clears } = markerStorage();
    assert.equal(applyDesktopEnvironmentGeneration(env, storage), true); // first private boot
    values.set("token", "private-secret");
    // After reset there is no injection at all (official compiled default).
    assert.equal(applyDesktopEnvironmentGeneration(null, storage), true);
    assert.equal(clears(), 2);
    assert.equal(values.has("token"), false);
    assert.equal(values.has("raft_desktop_environment_generation"), false); // marker removed
    // And the following official boots stay quiet (marker gone).
    assert.equal(applyDesktopEnvironmentGeneration(null, storage), false);
    assert.equal(clears(), 2);
  });

  test("env A → env B clears even though both inject generation 1", () => {
    const a = environmentFor("https://raft.a.example");
    const b = environmentFor("https://raft.b.example");
    assert.ok(a && b);
    const { storage, values, clears } = markerStorage();
    assert.equal(applyDesktopEnvironmentGeneration(a, storage), true);
    values.set("token", "a-secret");
    assert.equal(applyDesktopEnvironmentGeneration(b, storage), true);
    assert.equal(clears(), 2);
    assert.equal(values.has("token"), false);
    assert.equal(values.get("raft_desktop_environment_generation"), "https://raft.b.example#1");
  });

  test("same origin restart does not clear", () => {
    const env = environmentFor("https://raft.a.example", 1);
    assert.ok(env);
    const { storage, values, clears } = markerStorage();
    assert.equal(applyDesktopEnvironmentGeneration(env, storage), true);
    values.set("token", "a-secret");
    assert.equal(applyDesktopEnvironmentGeneration(environmentFor("https://raft.a.example", 1), storage), false);
    assert.equal(clears(), 1);
    assert.equal(values.get("token"), "a-secret");
  });

  test("Desktop bridge detection is pinned to the native invoke function", () => {
    assert.equal(hasDesktopBridge({}), false);
    assert.equal(hasDesktopBridge({ __TAURI_INTERNALS__: {} }), false);
    assert.equal(hasDesktopBridge({ __TAURI_INTERNALS__: { invoke: "not-a-function" } }), false);
    assert.equal(hasDesktopBridge({ __TAURI_INTERNALS__: { invoke: () => undefined } }), true);
  });

  test("ordinary browser preserves compiled API and page-origin fallback", () => {
    assert.deepEqual(
      deriveRuntimeEndpoints(null, "https://compiled.invalid", "https://page.invalid", false),
      {
        apiOrigin: "https://compiled.invalid",
        apiBase: "https://compiled.invalid/api",
        socketOrigin: "https://compiled.invalid",
        desktopRuntimeError: null,
      },
    );

    assert.deepEqual(
      deriveRuntimeEndpoints(null, "", "https://page.invalid", false),
      {
        apiOrigin: "https://page.invalid",
        apiBase: "https://page.invalid/api",
        socketOrigin: "/",
        desktopRuntimeError: null,
      },
    );
  });

  test("valid Desktop tuples override compiled API and remote page origins", () => {
    assert.deepEqual(
      deriveRuntimeEndpoints(production, "https://compiled.invalid", "https://page.invalid", true),
      {
        apiOrigin: "https://api.raft.build",
        apiBase: "https://api.raft.build/api",
        socketOrigin: "https://api.raft.build",
        desktopRuntimeError: null,
      },
    );

    assert.deepEqual(
      deriveRuntimeEndpoints(staging, "https://compiled.invalid", "https://page.invalid", true),
      {
        apiOrigin: "https://api-aws-staging.botiverse.dev",
        apiBase: "https://api-aws-staging.botiverse.dev/api",
        socketOrigin: "https://api-aws-staging.botiverse.dev",
        desktopRuntimeError: null,
      },
    );
  });

  test("Desktop bridge with missing or invalid tuple does not fall back to compiled API or page origin", () => {
    assert.deepEqual(
      deriveRuntimeEndpoints(null, "https://compiled.invalid", "https://page.invalid", true),
      {
        apiOrigin: "",
        apiBase: "/api",
        socketOrigin: "/",
        desktopRuntimeError: INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
      },
    );
  });

  test("invalid Desktop runtime errors are typed before auth/socket requests can run", () => {
    assert.doesNotThrow(() => assertValidDesktopRuntimeEnvironment(null));

    assert.throws(
      () => assertValidDesktopRuntimeEnvironment(INVALID_DESKTOP_RUNTIME_ENVIRONMENT),
      (error) =>
        error instanceof Error &&
        error.name === "InvalidDesktopRuntimeEnvironmentError" &&
        error.message === "Invalid Desktop runtime environment" &&
        "code" in error &&
        error.code === INVALID_DESKTOP_RUNTIME_ENVIRONMENT,
    );
  });

  test("credential-bearing consumers fail closed through the validated runtime tuple", () => {
    assertGuardBeforeSinks("src/api/client.ts", [
      "localStorage.getItem(",
      "attachWebHttpClientTrace(config)",
    ], 1);
    assertGuardBeforeSinks("src/api/socket.ts", [
      "socket = io(",
      "auth: freshAuth()",
    ], 1);
    assertGuardBeforeSinks("src/utils/socialAuth.ts", [
      "return RUNTIME_API_BASE;",
    ], 1);
    assertGuardBeforeSinks("src/utils/refreshCoordinator.ts", [
      "axios.post(",
    ], 1);
    assertGuardBeforeSinks("src/utils/webAuthTrace.ts", [
      "const attestationResponse = await fetchImpl(",
    ], 2, { pairCallsWithSinks: true });
    assertGuardBeforeSinks("src/utils/selectScreenshot.ts", [
      "localStorage.getItem(",
    ], 1);
    assertGuardBeforeSinks("src/utils/server.ts", [
      "RUNTIME_API_ORIGIN.includes(",
    ], 1);
  });

  // ── environmentId "server" (Electron runtime-configured origin, phase 3-1) ──

  test("accepts the minimal three-key server environment and derives the rest", () => {
    const env = readDesktopRuntimeEnvironment({
      __RAFT_DESKTOP_ENVIRONMENT__: {
        apiOrigin: "https://raft.internal.example:8443",
        socketOrigin: "https://raft.internal.example:8443",
        generation: 2,
      },
    });
    assert.deepEqual(env, {
      environmentId: "server",
      generation: 2,
      frontendOrigin: "https://raft.internal.example:8443",
      apiOrigin: "https://raft.internal.example:8443",
      socketOrigin: "https://raft.internal.example:8443",
      updateAuthority: "none",
    });
  });

  test("server environment rejects non-https origins, paths, queries and bad generations", () => {
    const sameOrigin = "https://raft.internal.example:8443";
    const cases: unknown[] = [
      // non-https scheme on either slot (http private origins are refused: the
      // bundled renderer's stock CSP allows only https/wss connect targets)
      { apiOrigin: "http://raft.internal.example:8443", socketOrigin: sameOrigin, generation: 1 },
      { apiOrigin: sameOrigin, socketOrigin: "http://raft.internal.example:8443", generation: 1 },
      // path / query / fragment / credentials
      { apiOrigin: "https://raft.internal.example/sub", socketOrigin: sameOrigin, generation: 1 },
      { apiOrigin: "https://raft.internal.example?q=1", socketOrigin: sameOrigin, generation: 1 },
      { apiOrigin: "https://raft.internal.example#f", socketOrigin: sameOrigin, generation: 1 },
      { apiOrigin: "https://user:pw@raft.internal.example", socketOrigin: sameOrigin, generation: 1 },
      // dangerous schemes
      { apiOrigin: "javascript:alert(1)", socketOrigin: sameOrigin, generation: 1 },
      { apiOrigin: sameOrigin, socketOrigin: "file:///etc/passwd", generation: 1 },
      // generation must be a safe positive integer
      { apiOrigin: sameOrigin, socketOrigin: sameOrigin, generation: 0 },
      { apiOrigin: sameOrigin, socketOrigin: sameOrigin, generation: 1.5 },
      { apiOrigin: sameOrigin, socketOrigin: sameOrigin, generation: "2" },
      // shape: missing slot, or extra keys (the minimal shape is exactly 3)
      { apiOrigin: sameOrigin, generation: 1 },
      { apiOrigin: sameOrigin, socketOrigin: sameOrigin, generation: 1, environmentId: "server" },
      { apiOrigin: sameOrigin, socketOrigin: sameOrigin, generation: 1, frontendOrigin: sameOrigin },
    ];
    for (const value of cases) {
      assert.equal(
        readDesktopRuntimeEnvironment({ __RAFT_DESKTOP_ENVIRONMENT__: value }),
        null,
        `expected rejection: ${JSON.stringify(value)}`,
      );
    }
  });

  test("an invalid injected server tuple falls back to the compiled API origin", () => {
    // The Electron preload injects values derived from main-process config; a
    // malformed injection must read as "no environment" so the compiled
    // VITE_API_URL keeps steering requests — the Electron shell has no Tauri
    // bridge, so unlike the shell flow this falls back rather than blanking.
    assert.equal(
      readDesktopRuntimeEnvironment({
        __RAFT_DESKTOP_ENVIRONMENT__: { apiOrigin: "http://bad.example", socketOrigin: "http://bad.example", generation: 1 },
      }),
      null,
    );
    assert.deepEqual(
      deriveRuntimeEndpoints(null, "https://api.raft.build", "app://raft", false),
      {
        apiOrigin: "https://api.raft.build",
        apiBase: "https://api.raft.build/api",
        socketOrigin: "https://api.raft.build",
        desktopRuntimeError: null,
      },
    );
  });

  test("a valid server environment overrides the compiled API origin and clears storage on generation change", () => {
    const env = readDesktopRuntimeEnvironment({
      __RAFT_DESKTOP_ENVIRONMENT__: {
        apiOrigin: "https://raft.internal.example:8443",
        socketOrigin: "https://raft.internal.example:8443",
        generation: 3,
      },
    });
    assert.deepEqual(
      deriveRuntimeEndpoints(env, "https://api.raft.build", "app://raft", false),
      {
        apiOrigin: "https://raft.internal.example:8443",
        apiBase: "https://raft.internal.example:8443/api",
        socketOrigin: "https://raft.internal.example:8443",
        desktopRuntimeError: null,
      },
    );
    const events: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (key: string) => { events.push(key); },
      clear: () => { events.push("__clear__"); },
    };
    assert.equal(applyDesktopEnvironmentGeneration(env, storage, undefined), true);
    assert.deepEqual(events, ["__clear__", "raft_desktop_environment_generation"]);
  });
});

// #desktop-session-restore task #1 review — the degraded-restore card must
// show an absolute address even when the web build compiled a relative "/api".
test("absoluteApiBase resolves the relative web base against the page origin", () => {
  assert.equal(absoluteApiBase("/api", "http://localhost:5173"), "http://localhost:5173/api");
  assert.equal(absoluteApiBase("/api", "https://app.raft.build"), "https://app.raft.build/api");
});

test("absoluteApiBase passes an already-absolute desktop base through", () => {
  assert.equal(
    absoluteApiBase("http://127.0.0.1:5999/api", "app://raft"),
    "http://127.0.0.1:5999/api",
  );
});
