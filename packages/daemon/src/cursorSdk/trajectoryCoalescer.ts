// Coalesce the Cursor SDK's streamed text/thinking chunks into readable blocks.
//
// The SDK streams small increments with irregular gaps. The APM only merges
// chunks that arrive within 350 ms of each other, so a sentence was split into
// several activity rows (some blank or just "…"). Claude Code's driver emits
// whole blocks and never had the problem. This buffer lives in the driver so no
// other runtime is affected.
//
// Flush rules (the caller flushes on every boundary event; see CursorSdkRuntimeSession):
//   - the chunk kind changes (thinking <-> text)
//   - any non-text run event, run settlement, error, stop or close (the caller)
//   - the buffer reaches MAX_CHARS
//   - quiet for QUIET_MS AND the text ends at a line break or sentence end
//   - HARD_CAP_MS after the first buffered chunk, whatever the text looks like
// Chunks are joined verbatim: sanitizing would squash whitespace and glue words.

export type TrajectoryKind = "text" | "thinking";

export const TRAJECTORY_QUIET_MS = 1_500;
export const TRAJECTORY_HARD_CAP_MS = 5_000;
export const TRAJECTORY_MAX_CHARS = 2_000;

export interface TrajectoryCoalescerDeps {
  /** One finished block, already trimmed and never empty / "…". */
  emit(kind: TrajectoryKind, text: string): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  now?(): number;
}

/**
 * Whitespace-only or only ellipsis/dots/middle-dots/dashes/underscores: carries no
 * information, never shown. Deliberate: a lone "---" separator is dropped too.
 */
export function isBlankTrajectoryText(text: string): boolean {
  return /^[\s.…·\-_]*$/u.test(text);
}

/** Ends at a line break or a sentence terminator (optionally followed by closing quotes/brackets). */
export function endsAtBoundary(text: string): boolean {
  return /(?:\n\s*|[.!?。！？…]["'”’)\]」』]*\s*)$/u.test(text);
}

export class TrajectoryCoalescer {
  private kind: TrajectoryKind | null = null;
  private text = "";
  private startedAtMs = 0;
  private quietTimer: unknown = null;
  private capTimer: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: TrajectoryCoalescerDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Whether anything is buffered (test hook). */
  get pending(): boolean {
    return this.kind !== null;
  }

  push(kind: TrajectoryKind, chunk: string): void {
    if (chunk.length === 0) return;
    if (this.kind !== null && this.kind !== kind) this.flush();
    if (this.kind === null) {
      this.kind = kind;
      this.text = "";
      this.startedAtMs = (this.deps.now ?? Date.now)();
      this.capTimer = this.setTimer(() => this.flush(), TRAJECTORY_HARD_CAP_MS);
    }
    this.text += chunk;
    if (this.text.length >= TRAJECTORY_MAX_CHARS) {
      this.flush();
      return;
    }
    if (this.quietTimer !== null) this.clearTimer(this.quietTimer);
    this.quietTimer = this.setTimer(() => {
      this.quietTimer = null;
      if (endsAtBoundary(this.text)) this.flush();
      // Otherwise keep waiting for more text, bounded by the hard cap.
    }, TRAJECTORY_QUIET_MS);
  }

  /** Emit what is buffered (if it says anything) and reset. Idempotent. */
  flush(): void {
    if (this.quietTimer !== null) this.clearTimer(this.quietTimer);
    if (this.capTimer !== null) this.clearTimer(this.capTimer);
    this.quietTimer = null;
    this.capTimer = null;
    const kind = this.kind;
    const text = this.text.trim();
    this.kind = null;
    this.text = "";
    if (kind === null || isBlankTrajectoryText(text)) return;
    this.deps.emit(kind, text);
  }

  /** Drop everything without emitting (session torn down without a turn to attach it to). */
  dispose(): void {
    if (this.quietTimer !== null) this.clearTimer(this.quietTimer);
    if (this.capTimer !== null) this.clearTimer(this.capTimer);
    this.quietTimer = null;
    this.capTimer = null;
    this.kind = null;
    this.text = "";
  }
}
