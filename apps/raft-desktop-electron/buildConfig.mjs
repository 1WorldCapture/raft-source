// Build-time API endpoint configuration — the single source both bundlers read:
//   - vite (frontend/vite.config.ts) bakes the API origin the renderer talks to
//     and, for non-official origins, widens the index.html CSP by exactly that
//     origin;
//   - tsup (tsup.config.ts) bakes the same origin into the main bundle as
//     __RAFT_DESKTOP_API_ORIGIN__ (consumed by src/app/configuredApiOrigin.ts).
// The value comes ONLY from the VITE_API_URL environment variable at build
// time; server addresses never live in the repo. Unset → the official
// production backend, byte-identical to the pre-configurable official builds.

/** Origins served by the official backend (self-update + stock allowlists). */
export const OFFICIAL_API_ORIGINS = Object.freeze(
  new Set(["https://api.raft.build", "https://api-aws-staging.botiverse.dev"]),
);

export const DEFAULT_API_ORIGIN = "https://api.raft.build";

/**
 * Normalize a configured API base to its origin: http/https only, no
 * credentials, no query/hash; any path and trailing slash are dropped (the
 * runtime always derives `<origin>/api`). Returns null when unusable.
 */
export function parseApiOrigin(raw) {
  if (typeof raw !== "string") return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin;
}

/** The WebSocket origin matching an http(s) origin (scheme swap only). */
export function toWsOrigin(apiOrigin) {
  if (apiOrigin.startsWith("https:")) return `wss:${apiOrigin.slice("https:".length)}`;
  return `ws:${apiOrigin.slice("http:".length)}`;
}

/**
 * Resolve the build-time API configuration from the environment. Throws on an
 * invalid VITE_API_URL so a misconfigured build fails loudly instead of
 * silently shipping a build pointed at the wrong backend.
 *
 * Returns { apiOrigin, isOfficial, wsOrigin }.
 */
export function resolveBuildApiConfig(env = process.env) {
  const raw = typeof env.VITE_API_URL === "string" ? env.VITE_API_URL.trim() : "";
  if (raw === "") {
    return { apiOrigin: DEFAULT_API_ORIGIN, isOfficial: true, wsOrigin: toWsOrigin(DEFAULT_API_ORIGIN) };
  }
  const apiOrigin = parseApiOrigin(raw);
  if (!apiOrigin) {
    throw new Error(`VITE_API_URL must be an http(s) origin (path/query/credentials not allowed), got: ${raw}`);
  }
  return { apiOrigin, isOfficial: OFFICIAL_API_ORIGINS.has(apiOrigin), wsOrigin: toWsOrigin(apiOrigin) };
}

/** tsup `define` entries baking the configured origin into the main bundle. */
export function desktopApiDefines(config) {
  return { __RAFT_DESKTOP_API_ORIGIN__: JSON.stringify(config.apiOrigin) };
}

// CSP widening (self-hosted builds only). The stock policy allows only
// https/wss for fetch and websockets and https-sourced images/media; an http
// self-hosted backend would be blocked by the renderer's own CSP before the
// main-process CORS bridge is ever reached. Widen by exactly the configured
// origins — never bare `http:`/`ws:` — so look-alike hosts stay blocked.
const CSP_DIRECTIVES_TO_WIDEN = Object.freeze(["connect-src", "img-src", "media-src"]);

function widenCspDirectives(content, additions) {
  const directives = content.split(";").map((part) => part.trim()).filter((part) => part.length > 0);
  const seen = new Set();
  const widened = directives.map((directive) => {
    const name = directive.split(/\s+/)[0];
    if (!CSP_DIRECTIVES_TO_WIDEN.includes(name)) return directive;
    seen.add(name);
    const extra = additions[name] ?? [];
    const sources = directive.split(/\s+/).slice(1);
    // Keep the directive finite and idempotent under repeated widening.
    const merged = [...sources];
    for (const origin of extra) if (!merged.includes(origin)) merged.push(origin);
    return [name, ...merged].join(" ");
  });
  const missing = CSP_DIRECTIVES_TO_WIDEN.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`index.html CSP is missing directives this build must widen: ${missing.join(", ")}`);
  }
  return widened.join("; ");
}

/**
 * Rewrite the CSP meta tag of the built index.html. Returns the html unchanged
 * for official builds (byte-identical to the stock policy) and throws when the
 * meta tag or an expected directive is missing — a drifted policy must fail
 * the build, not silently ship a blocked (or over-open) one.
 */
export function applyCspToHtml(html, config) {
  if (config.isOfficial) return html;
  const additions = {
    "connect-src": [config.apiOrigin, config.wsOrigin],
    "img-src": [config.apiOrigin],
    "media-src": [config.apiOrigin],
  };
  const metaPattern = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/;
  const meta = html.match(metaPattern);
  if (!meta) throw new Error('index.html has no <meta http-equiv="Content-Security-Policy"> to configure');
  const replaced = meta[0].replace(/content="([^"]*)"/, (_all, content) => `content="${widenCspDirectives(content, additions)}"`);
  return html.slice(0, meta.index) + replaced + html.slice(meta.index + meta[0].length);
}

/** Vite plugin applying the CSP widening during index.html transforms. */
export function raftCspPlugin(config) {
  return {
    name: "raft-build-csp",
    transformIndexHtml(html) {
      return applyCspToHtml(html, config);
    },
  };
}
