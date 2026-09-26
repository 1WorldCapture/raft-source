import { createRefreshAttemptId } from "./ids";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly error: string;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.error = message;
    this.body = body;
    this.code = body && typeof body === "object" && "code" in body && typeof body.code === "string"
      ? body.code
      : null;
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface ApiClientOptions {
  getOrigin: () => string | null;
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  getServerId: () => string | null;
  /** Stable `ari_<32 hex>` id, persisted for this install. */
  getInstallationId?: () => string | null;
  /** Per-refresh `arf_<16 hex>` id. Defaults to a random id. */
  createAttemptId?: () => string;
  setTokens: (tokens: TokenPair) => void;
  onSessionExpired: () => void;
  onApiError?: (error: ApiError) => void;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Send the bearer token. Defaults to true. */
  auth?: boolean;
  /** Send X-Server-Id when a server is selected. Defaults to true. */
  server?: boolean;
  /** Internal: the 401 retry has already happened. */
  retry?: boolean;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && body.error) {
    return body.error;
  }
  return fallback;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function shouldLogoutAfterRefresh(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isAuthPath(path: string): boolean {
  return path.includes("/auth/");
}

function defaultRefreshAttemptId(): string {
  return createRefreshAttemptId();
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let refreshInFlight: Promise<TokenPair> | null = null;

  function apiUrl(path: string): string {
    const origin = options.getOrigin();
    if (!origin) {
      throw new ApiError("Set a server address before calling the API", 0, null);
    }
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${origin}/api${suffix}`;
  }

  async function refreshTokens(): Promise<TokenPair> {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const refreshToken = options.getRefreshToken();
        if (!refreshToken) {
          options.onSessionExpired();
          throw new ApiError("Missing refresh token", 401, null);
        }
        const headers: Record<string, string> = {
          Accept: "application/json",
          "Content-Type": "application/json",
        };
        const installationId = options.getInstallationId?.();
        const attemptId = options.createAttemptId?.() ?? defaultRefreshAttemptId();
        if (installationId && /^ari_[0-9a-f]{32}$/.test(installationId) && /^arf_[0-9a-f]{16}$/.test(attemptId)) {
          headers["X-Slock-Auth-Installation-Id"] = installationId;
          headers["X-Slock-Auth-Refresh-Attempt-Id"] = attemptId;
        }
        const response = await fetchImpl(apiUrl("/auth/refresh"), {
          method: "POST",
          headers,
          body: JSON.stringify({ refreshToken }),
        });
        const body = await readBody(response);
        if (!response.ok) {
          if (response.status === 401) options.onSessionExpired();
          throw new ApiError(errorMessage(body, "Token refresh failed"), response.status, body);
        }
        if (!body || typeof body !== "object" || typeof (body as TokenPair).accessToken !== "string" || typeof (body as TokenPair).refreshToken !== "string") {
          throw new ApiError("Token refresh returned an unexpected payload", response.status, body);
        }
        const tokens = {
          accessToken: (body as TokenPair).accessToken,
          refreshToken: (body as TokenPair).refreshToken,
        };
        options.setTokens(tokens);
        return tokens;
      })().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function request<T = unknown>(path: string, init: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    if (init.auth !== false) {
      const token = options.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    if (init.server !== false) {
      const serverId = options.getServerId();
      if (serverId) headers["X-Server-Id"] = serverId;
    }

    let response: Response;
    try {
      response = await fetchImpl(apiUrl(path), {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network request failed";
      throw new ApiError(message, 0, null);
    }

    const body = await readBody(response);
    if (
      response.status === 401 &&
      !init.retry &&
      init.auth !== false &&
      !isAuthPath(path)
    ) {
      await refreshTokens();
      return request<T>(path, { ...init, retry: true });
    }
    if (!response.ok) {
      const apiError = new ApiError(errorMessage(body, `Request failed (${response.status})`), response.status, body);
      options.onApiError?.(apiError);
      throw apiError;
    }
    return body as T;
  }

  return {
    request,
    refreshTokens,
    get: <T = unknown>(path: string, init?: Omit<RequestOptions, "method" | "body">) =>
      request<T>(path, { ...init, method: "GET" }),
    post: <T = unknown>(path: string, body?: unknown, init?: Omit<RequestOptions, "method" | "body">) =>
      request<T>(path, { ...init, method: "POST", body }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
