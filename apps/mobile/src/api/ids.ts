function randomHex(bytes: number): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    const buffer = new Uint8Array(bytes);
    cryptoObj.getRandomValues(buffer);
    return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const uuid = (globalThis as { expo?: { uuidv4?: () => string } }).expo?.uuidv4;
  if (uuid) {
    let hex = "";
    while (hex.length < bytes * 2) hex += uuid().replace(/-/g, "");
    return hex.slice(0, bytes * 2);
  }
  throw new Error("No random source");
}

/** Stable per-install id. The server replays the same rotated tokens for 15 minutes when this matches. */
export function createInstallationId(): string {
  return `ari_${randomHex(16)}`;
}

export function createRefreshAttemptId(): string {
  return `arf_${randomHex(8)}`;
}

/** Idempotency key for POST /api/v2/messages. Reuse it when retrying the same send. */
export function createRandomId(): string {
  return `m_${randomHex(16)}`;
}
