// Task #9 (private deployment): the managed-MCP private-mode allowlist.
// Official deployments ignore the allowlist env ENTIRELY (byte-identical
// posture); private deployments re-open exactly the administrator-configured
// ranges; hard-blocked ranges (loopback / link-local cloud-metadata /
// unspecified / multicast) are never re-openable.
import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";

import {
  isManagedMcpAddressAllowed,
  ManagedMcpGatewayError,
  safeLookup,
  validateManagedMcpEndpoint,
} from "./managedMcpGateway.js";

const prevMode = process.env.RAFT_DEPLOYMENT_MODE;
const prevNetworks = process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS;
const prevHosts = process.env.RAFT_MANAGED_MCP_ALLOWED_HOSTS;

function clearAllowlistEnv(): void {
  delete process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS;
  delete process.env.RAFT_MANAGED_MCP_ALLOWED_HOSTS;
}

beforeEach(() => {
  clearAllowlistEnv();
});

afterAll(() => {
  for (const [prev, key] of [
    [prevMode, "RAFT_DEPLOYMENT_MODE"],
    [prevNetworks, "RAFT_MANAGED_MCP_ALLOWED_NETWORKS"],
    [prevHosts, "RAFT_MANAGED_MCP_ALLOWED_HOSTS"],
  ] as const) {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
});

describe("official mode ignores the allowlist env entirely", () => {
  beforeAll(() => {
    delete process.env.RAFT_DEPLOYMENT_MODE;
  });

  test("configured networks still blocked, message byte-stable (no allowlist hint)", () => {
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "10.20.0.0/16";
    assert.equal(isManagedMcpAddressAllowed("10.20.1.5"), false);
    assert.throws(
      () => validateManagedMcpEndpoint("https://10.20.1.5/mcp"),
      (error: unknown) =>
        error instanceof ManagedMcpGatewayError
        && error.message === "MCP endpoint address is not allowed.",
    );
    // Suffix pre-check unchanged.
    assert.throws(
      () => validateManagedMcpEndpoint("https://mcp.internal/mcp"),
      (error: unknown) =>
        error instanceof ManagedMcpGatewayError
        && error.message === "MCP endpoint host is not allowed.",
    );
  });
});

describe("private mode allowlist", () => {
  beforeAll(() => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
  });

  test("configured CIDRs re-open exactly those ranges", () => {
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "10.20.0.0/16,100.64.0.0/10";
    assert.equal(isManagedMcpAddressAllowed("10.20.1.5"), true);
    assert.equal(isManagedMcpAddressAllowed("100.64.3.2"), true);
    // Outside the allowlist: still blocked.
    assert.equal(isManagedMcpAddressAllowed("10.21.0.1"), false);
    assert.equal(isManagedMcpAddressAllowed("192.168.1.1"), false);
    // A literal allowed IP passes validation too.
    assert.equal(validateManagedMcpEndpoint("https://10.20.1.5/mcp").hostname, "10.20.1.5");
  });

  test("hard-blocked ranges are never re-openable, even when configured", () => {
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "127.0.0.0/8,169.254.0.0/16,0.0.0.0/8,224.0.0.0/4,::1/128,fe80::/10,10.20.0.0/16";
    for (const address of ["127.0.0.1", "169.254.169.254", "0.0.0.1", "224.0.0.5", "::1", "fe80::1"]) {
      assert.equal(isManagedMcpAddressAllowed(address), false, address);
    }
    // Wider ranges covering hard-blocked space are ignored as a whole.
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "0.0.0.0/0";
    assert.equal(isManagedMcpAddressAllowed("10.20.1.5"), false);
    // The same env line still honors its clean entries.
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "169.254.0.0/16,10.20.0.0/16";
    assert.equal(isManagedMcpAddressAllowed("10.20.1.5"), true);
    assert.equal(isManagedMcpAddressAllowed("169.254.169.254"), false);
  });

  test("malformed entries are skipped without disabling the list", () => {
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "not-a-cidr,10.20.0.0/16";
    assert.equal(isManagedMcpAddressAllowed("10.20.1.5"), true);
  });

  test("allowed hosts bypass only the suffix pre-check; IPs still must qualify", () => {
    process.env.RAFT_MANAGED_MCP_ALLOWED_HOSTS = "mcp.corp.example";
    // Hostname pre-check passes for the allowlisted internal-style name.
    assert.equal(validateManagedMcpEndpoint("https://mcp.corp.example/mcp").hostname, "mcp.corp.example");
    // A non-allowlisted .internal host stays blocked, with the private hint.
    assert.throws(
      () => validateManagedMcpEndpoint("https://other.internal/mcp"),
      (error: unknown) =>
        error instanceof ManagedMcpGatewayError
        && error.message.includes("RAFT_MANAGED_MCP_ALLOWED_NETWORKS"),
    );
    // localhost never re-opens via the hosts list.
    process.env.RAFT_MANAGED_MCP_ALLOWED_HOSTS = "localhost,mcp.corp.example";
    assert.throws(() => validateManagedMcpEndpoint("https://localhost/mcp"), ManagedMcpGatewayError);
  });

  test("no allowlist configured: private posture equals the default block table", () => {
    assert.equal(isManagedMcpAddressAllowed("10.20.1.5"), false);
    assert.equal(isManagedMcpAddressAllowed("8.8.8.8"), true);
  });
});

// Filter semantics (PM review): safeLookup hands ONLY judgment-passing
// addresses to the connection layer — mixed resolutions must never let the
// connection fall onto a blocked address, and all-blocked resolutions are
// refused. dns.promises.lookup is mocked; the undici agent uses this lookup
// for its actual connects, so filtering here IS filtering the connection.
import dns from "node:dns";
import { vi } from "vitest";

vi.spyOn(dns.promises, "lookup").mockImplementation(async () => {
  throw new Error("replaced per-test below");
});

function mockResolution(addresses: Array<{ address: string; family: number }>): void {
  vi.mocked(dns.promises.lookup).mockImplementation(async () => addresses as never);
}

describe("safeLookup filter semantics (private mode)", () => {
  beforeAll(() => {
    process.env.RAFT_DEPLOYMENT_MODE = "private";
  });

  test("mixed [allowed, 127.0.0.1] resolution connects only via the allowed address", async () => {
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "10.20.0.0/16";
    mockResolution([
      { address: "10.20.1.5", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const result = await new Promise<{ err: Error | null; address: string; family: number }>((resolve) => {
      void safeLookup("mcp.corp.example", {}, (err, address, family) => resolve({ err, address: String(address), family: family ?? 0 }));
    });
    assert.equal(result.err, null);
    assert.equal(result.address, "10.20.1.5");
    // all:true hands over the FILTERED list — the loopback entry is gone.
    const all = await new Promise<{ err: Error | null; addresses: dns.LookupAddress[] }>((resolve) => {
      void safeLookup("mcp.corp.example", { all: true }, (err, addresses) => resolve({ err, addresses: (addresses as dns.LookupAddress[]) ?? [] }));
    });
    assert.equal(all.err, null);
    assert.deepEqual(all.addresses.map((a) => a.address), ["10.20.1.5"]);
  });

  test("all-blocked resolution is refused with the allowlist hint", async () => {
    mockResolution([{ address: "127.0.0.1", family: 4 }]);
    const result = await new Promise<{ err: (Error & { code?: string }) | null }>((resolve) => {
      void safeLookup("evil.example", {}, (err) => resolve({ err: err as (Error & { code?: string }) | null }));
    });
    assert.ok(result.err);
    assert.equal(result.err.code, "EACCES");
    assert.ok(result.err.message.includes("RAFT_MANAGED_MCP_ALLOWED_NETWORKS"));
  });

  test("official mode: any private resolution is refused regardless of env", async () => {
    delete process.env.RAFT_DEPLOYMENT_MODE;
    process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "10.20.0.0/16";
    mockResolution([
      { address: "8.8.8.8", family: 4 },
      { address: "10.20.1.5", family: 4 },
    ]);
    const result = await new Promise<{ err: Error | null; address: string }>((resolve) => {
      void safeLookup("mcp.example", {}, (err, address) => resolve({ err: err as Error | null, address: String(address) }));
    });
    assert.equal(result.err, null);
    assert.equal(result.address, "8.8.8.8", "private address filtered out in official mode");
  });
});

test("out-of-range prefixes are skipped without breaking the list (PM must-fix)", () => {
  process.env.RAFT_DEPLOYMENT_MODE = "private";
  // /40 (v4) and /200 (v6) exceed the address family's bits — previously a
  // RangeError inside the lazy allowlist load would fail EVERY call.
  process.env.RAFT_MANAGED_MCP_ALLOWED_NETWORKS = "10.0.0.0/40,fd00::/200,10.20.0.0/16";
  assert.equal(isManagedMcpAddressAllowed("10.20.1.5"), true, "valid entry still honored");
  assert.equal(isManagedMcpAddressAllowed("10.21.0.1"), false);
});
