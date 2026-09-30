/**
 * Import a heavy dependency on first use.
 *
 * - Concurrent first callers share one load (two agents launching the same
 *   runtime at once import the SDK once).
 * - A failed load is not cached: the next caller retries. Every caller gets
 *   the rejection through its own await, so nothing is left unhandled.
 * - `peek()` returns the module once loaded and never triggers a load.
 */
export type LazyModule<T> = {
  get(): Promise<T>;
  peek(): T | null;
};

export function createLazyModule<T>(load: () => Promise<T>): LazyModule<T> {
  let pending: Promise<T> | null = null;
  let value: T | null = null;
  return {
    get() {
      pending ??= load().then(
        (module) => {
          value = module;
          return module;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    peek() {
      return value;
    },
  };
}
