// Type surface for buildConfig.mjs (JSDoc-typed at runtime; see the .mjs for
// the authoritative behavior comments).
export declare const OFFICIAL_API_ORIGINS: ReadonlySet<string>;
export declare const DEFAULT_API_ORIGIN: string;
export declare function parseApiOrigin(raw: unknown): string | null;
export declare function toWsOrigin(apiOrigin: string): string;
export declare function resolveBuildApiConfig(env?: Record<string, string | undefined>): {
  apiOrigin: string;
  isOfficial: boolean;
  wsOrigin: string;
};
export declare function desktopApiDefines(config: { apiOrigin: string }): Record<string, string>;
export declare function applyCspToHtml(html: string, config: { apiOrigin: string; isOfficial: boolean; wsOrigin: string }): string;
export declare function raftCspPlugin(config: { apiOrigin: string; isOfficial: boolean; wsOrigin: string }): {
  name: string;
  transformIndexHtml(html: string): string;
};
