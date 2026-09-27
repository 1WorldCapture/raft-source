// Shared shape of the ComputerHost converge outcome — the single source for
// main-process state and the renderer's notice derivation. Mirrored (not
// imported) on the renderer side like the rest of the status report.

export type ConvergeState =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Reduce a caught converge/recycle error to a stable {code, message} the
 * renderer can branch on. ComputerServiceError codes (e.g.
 * SERVICE_VERSION_SKEW) are preserved verbatim; everything else collapses to
 * CONVERGE_FAILED so the card never has to guess at arbitrary strings.
 */
export function reduceConvergeFailure(
  prefix: string,
  error: unknown,
): { code: string; message: string } {
  const code = typeof (error as { code?: unknown })?.code === "string" && (error as { code: string }).code
    ? (error as { code: string }).code
    : "CONVERGE_FAILED";
  const detail = error instanceof Error ? error.message : String(error);
  return { code, message: `${prefix}${detail}` };
}
