import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// ../../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/session-resources.js
var sessionResourceCleanups = /* @__PURE__ */ new Set();
function registerSessionResourceCleanup(cleanup) {
  sessionResourceCleanups.add(cleanup);
  return () => {
    sessionResourceCleanups.delete(cleanup);
  };
}
function cleanupSessionResources(sessionId) {
  const errors = [];
  for (const cleanup of sessionResourceCleanups) {
    try {
      cleanup(sessionId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to cleanup session resources");
  }
}

// ../../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/utils/uuid.js
var MAX_UUID_V7_TIMESTAMP = 281474976710655;
var MAX_SEQUENCE = (1n << 41n) - 1n;
var lastOrdinaryTimestamp = -1;
var sequence;
function uuidv7(timestampMs) {
  const requestedTimestamp = timestampMs ?? Date.now();
  if (!Number.isInteger(requestedTimestamp) || requestedTimestamp < 0 || requestedTimestamp > MAX_UUID_V7_TIMESTAMP) {
    throw new RangeError(`UUIDv7 timestamp must be an integer between 0 and ${MAX_UUID_V7_TIMESTAMP}`);
  }
  const effectiveTimestamp = timestampMs === void 0 ? Math.max(requestedTimestamp, lastOrdinaryTimestamp) : timestampMs;
  if (timestampMs === void 0)
    lastOrdinaryTimestamp = effectiveTimestamp;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  if (sequence === void 0) {
    sequence = BigInt(bytes[1]) << 32n | BigInt(bytes[2]) << 24n | BigInt(bytes[3]) << 16n | BigInt(bytes[4]) << 8n | BigInt(bytes[5]);
  } else {
    if (sequence === MAX_SEQUENCE)
      throw new RangeError("UUIDv7 generator sequence exhausted");
    sequence++;
  }
  const timestamp = BigInt(effectiveTimestamp);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8)) & 255;
  }
  bytes[6] = 112 | Number(sequence >> 37n & 0x0fn);
  bytes[7] = Number(sequence >> 29n & 0xffn);
  bytes[8] = 128 | Number(sequence >> 23n & 0x3fn);
  bytes[9] = Number(sequence >> 15n & 0xffn);
  bytes[10] = Number(sequence >> 7n & 0xffn);
  bytes[11] = Number((sequence & 0x7fn) << 1n) | bytes[11] & 1;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export {
  registerSessionResourceCleanup,
  cleanupSessionResources,
  uuidv7
};
