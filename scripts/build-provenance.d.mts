// Types for scripts/build-provenance.mjs.
//
// Build configs (`tsup.config.ts`) import the resolver, but the module is plain
// ESM JavaScript with JSDoc — TypeScript will not infer its exports without
// this declaration. The shapes must stay in sync with the implementation.
export declare const UNKNOWN_COMMIT: "unknown";

export interface BuildCommit {
  sha: string;
  short: string;
  source: "env" | "git" | "unknown";
}

export interface ResolveBuildCommitOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Injected for tests; defaults to `git rev-parse HEAD`. */
  runGit?: (args: string[], cwd: string) => string;
}

export declare function resolveBuildCommit(options?: ResolveBuildCommitOptions): BuildCommit;

export declare function buildCommitDefines(
  prefix: string,
  options?: ResolveBuildCommitOptions,
): Record<string, string>;