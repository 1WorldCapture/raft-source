import { describe, expect, it } from "vitest";
import { resolveListenHost, resolveTrustProxy } from "./trustProxy.js";

describe("resolveTrustProxy", () => {
  it("keeps the old default when TRUST_PROXY is unset", () => {
    expect(resolveTrustProxy(undefined, "production")).toBe(1);
    expect(resolveTrustProxy(undefined, "development")).toBeUndefined();
    expect(resolveTrustProxy("  ", undefined)).toBeUndefined();
  });

  it("lets TRUST_PROXY opt in without NODE_ENV=production", () => {
    expect(resolveTrustProxy("1", undefined)).toBe(1);
    expect(resolveTrustProxy("2", "development")).toBe(2);
    expect(resolveTrustProxy("true", undefined)).toBe(true);
    expect(resolveTrustProxy("loopback", undefined)).toBe("loopback");
    expect(resolveTrustProxy("127.0.0.1, ::1", undefined)).toBe("127.0.0.1, ::1");
  });

  it("lets TRUST_PROXY opt out even in production", () => {
    expect(resolveTrustProxy("false", "production")).toBe(false);
  });
});

describe("resolveListenHost", () => {
  it("binds all interfaces unless HOST is set", () => {
    expect(resolveListenHost(undefined)).toBeUndefined();
    expect(resolveListenHost("")).toBeUndefined();
    expect(resolveListenHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
