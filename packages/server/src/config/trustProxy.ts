/**
 * Express `trust proxy` setting for the server.
 *
 * Deployments behind a reverse proxy (e.g. a self-hosted nginx in front of the
 * server) need Express to read the client address from X-Forwarded-For, or
 * rate limiting and audit logs see every request as coming from the proxy.
 * Historically this was only enabled for NODE_ENV=production, which also
 * switches on unrelated production-only behavior; TRUST_PROXY lets a
 * deployment opt in on its own.
 *
 * TRUST_PROXY accepts what Express accepts: a hop count ("1"), "true"/"false",
 * or a comma-separated list of addresses/subnets or presets ("loopback").
 * Unset: keep the previous behavior (trust one hop in production only).
 */
export function resolveTrustProxy(
  raw: string | undefined = process.env.TRUST_PROXY,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value) return nodeEnv === "production" ? 1 : undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** Optional bind address for the HTTP server (e.g. 127.0.0.1 behind a proxy). */
export function resolveListenHost(raw: string | undefined = process.env.HOST): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}
