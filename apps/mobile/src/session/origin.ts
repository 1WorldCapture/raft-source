/**
 * Build-time server address from `EXPO_PUBLIC_RAFT_SERVER_URL`.
 * There is no default. A missing or invalid value means the build is not configured.
 */
export function resolveBundledServerOrigin(configured?: string): string | null {
  const trimmed = configured?.trim();
  if (!trimmed) return null;
  try {
    return normalizeServerOrigin(trimmed);
  } catch {
    return null;
  }
}

export const BUNDLED_SERVER_ORIGIN = resolveBundledServerOrigin(process.env.EXPO_PUBLIC_RAFT_SERVER_URL);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function prefersHttp(hostname: string): boolean {
  if (LOCAL_HOSTS.has(hostname)) return true;
  if (hostname.endsWith(".local")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Accept a private-deployment origin. Users may paste `host:port` or a full
 * URL. A trailing `/api` is stripped because the client adds that prefix.
 */
export function normalizeServerOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter the server address");
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${prefersHttp(trimmed.split("/")[0]?.split(":")[0] ?? trimmed) ? "http" : "https"}://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("That server address is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server address must start with http:// or https://");
  }
  if (url.username || url.password) {
    throw new Error("Don't include a username or password in the server address");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/api") {
    throw new Error("Use the server origin, for example https://raft.example.com");
  }
  if (url.search || url.hash) {
    throw new Error("Use the server origin without a query or hash");
  }

  return url.origin;
}
