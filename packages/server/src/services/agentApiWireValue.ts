// Agent API response contracts describe the JSON wire payload. Server handlers
// may still hand us DB/domain objects containing Date instances, which Express
// would stringify only after this contract check. Normalize that boundary here
// so shared schemas stay wire-only instead of accepting server-domain values.
export function normalizeAgentApiWireValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeAgentApiWireValue);
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, normalizeAgentApiWireValue(nested)]),
    );
  }
  return value;
}
