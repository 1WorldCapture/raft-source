import { ApiError } from "../api/client";

/** How long to spin before the session-not-ready state becomes an error. */
export const SESSION_READY_WAIT_MS = 5_000;

export function shouldStopWaitingForSession(waitedMs: number, ready: boolean, hasOrigin: boolean): boolean {
  if (ready && hasOrigin) return false;
  return waitedMs >= SESSION_READY_WAIT_MS;
}

/** Network failures and timeouts reuse the existing load-failed copy. Server errors keep their message. */
export function pmLoadErrorMessage(caught: unknown, loadFailed: string): string {
  if (caught instanceof ApiError && caught.status === 0) return loadFailed;
  if (caught instanceof ApiError) return caught.message;
  return loadFailed;
}
