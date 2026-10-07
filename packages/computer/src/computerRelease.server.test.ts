// Task #5 (private deployment, phase 2): the upgrade-source precedence chain
// and the server-backend origin derivation. Regression guards for the exact
// scenarios PM's review called out — a multi-server Computer (owner's Mac:
// raftbuild + zcode + knowledge) must keep the default hands backend unless
// something explicitly selected server, and the private-mode default must
// fail closed on multi-origin rather than picking a side.
import assert from "node:assert/strict";
import { test } from "vitest";

import { withHermeticHome } from "./test/hermeticAssertions.js";
import {
  DEFAULT_UPGRADE_BASE_URL,
  resolveUpgradeSourceForHome,
  resolveServerDownloadsBase,
  UPGRADE_BASE_URL_ENV,
} from "./computerRelease.js";
import { RELEASE_BACKEND_ENV, readReleaseBackend, writeReleaseBackend } from "./lib/releaseBackendState.js";
import { writeServerAttachment, type ServerAttachment } from "./serverState.js";
import { ComputerServiceError } from "./services/errors.js";

function attachment(serverId: string, serverUrl: string, slug: string): ServerAttachment {
  return {
    kind: "computer-attachment",
    serverId,
    serverSlug: slug,
    serverMachineId: `machine-${slug}`,
    apiKey: `sk_computer_${slug}`,
    serverUrl,
  };
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

const PRIVATE_ORIGIN = "https://raft.internal.example:18443";

async function attach(home: string, ...items: ServerAttachment[]): Promise<void> {
  for (const item of items) await writeServerAttachment(home, item);
}

test("release backend state round-trips and reads leniently", async () => {
  await withHermeticHome(async (home) => {
    assert.equal(await readReleaseBackend(home), null);
    await writeReleaseBackend(home, "server");
    assert.equal(await readReleaseBackend(home), "server");
    // A corrupt value reads as "no selection" — never throws (channel-file
    // contract), the caller's default chain applies.
    const { writeFile } = await import("node:fs/promises");
    const { releaseBackendPath } = await import("./paths.js");
    await writeFile(releaseBackendPath(home), "bogus\n", "utf8");
    assert.equal(await readReleaseBackend(home), null);
  });
});

test("default is hands — a multi-server Computer with no selection is unaffected", async () => {
  await withHermeticHome(async (home) => {
    // The owner-Mac shape: three attached servers, no env, no persisted
    // backend, no private switch. Upgrades must resolve exactly as before.
    await attach(
      home,
      attachment(UUID_A, "https://raftbuild.example", "raftbuild"),
      attachment(UUID_B, "https://zcode.example", "zcode"),
      attachment(UUID_C, "https://knowledge.example", "knowledge"),
    );
    const source = await resolveUpgradeSourceForHome(home, {});
    assert.equal(source.backend, "hands");
    assert.equal(source.baseUrl, DEFAULT_UPGRADE_BASE_URL);
  });
});

test("explicit base override is the true top override regardless of backend", async () => {
  await withHermeticHome(async (home) => {
    await attach(home, attachment(UUID_A, PRIVATE_ORIGIN, "internal"));
    await writeReleaseBackend(home, "server");
    const source = await resolveUpgradeSourceForHome(home, {
      [UPGRADE_BASE_URL_ENV]: "https://mirror.example/computer/",
    });
    // Behavior fix (task #5): historically this env was silently ignored
    // under the hands backend; now it always selects the manifest reader.
    assert.equal(source.backend, "legacy-cdn");
    assert.equal(source.baseUrl, "https://mirror.example/computer");
  });
});

test("persisted server backend derives the base from the single attached origin", async () => {
  await withHermeticHome(async (home) => {
    await writeReleaseBackend(home, "server");
    // No attachments yet: fail closed with the absent-origin error.
    await assert.rejects(
      resolveUpgradeSourceForHome(home, {}),
      (error: unknown) => error instanceof ComputerServiceError && error.message.includes("UPGRADE_SERVER_ORIGIN_ABSENT"),
    );

    await attach(home, attachment(UUID_A, `${PRIVATE_ORIGIN}/`, "internal"));
    const source = await resolveUpgradeSourceForHome(home, {});
    assert.equal(source.backend, "server");
    assert.equal(source.baseUrl, `${PRIVATE_ORIGIN}/downloads/computer`);
  });
});

test("explicit env backend outranks the persisted state", async () => {
  await withHermeticHome(async (home) => {
    await attach(home, attachment(UUID_A, PRIVATE_ORIGIN, "internal"));
    await writeReleaseBackend(home, "server");
    const source = await resolveUpgradeSourceForHome(home, { [RELEASE_BACKEND_ENV]: "legacy-cdn" });
    assert.equal(source.backend, "legacy-cdn");
    assert.equal(source.baseUrl, DEFAULT_UPGRADE_BASE_URL);
  });
});

test("invalid backend env fails typed with the stable code", async () => {
  await withHermeticHome(async (home) => {
    await assert.rejects(
      resolveUpgradeSourceForHome(home, { [RELEASE_BACKEND_ENV]: "npm" }),
      (error: unknown) => error instanceof ComputerServiceError && error.message.includes("K_SOURCE_BACKEND_INVALID"),
    );
  });
});

test("private-mode default (trigger B) selects server only with an attachment, and fails closed on multi-origin", async () => {
  await withHermeticHome(async (home) => {
    // Private switch alone, nothing attached → stays hands (no derivation
    // possible, existing upgrades unaffected).
    const unattached = await resolveUpgradeSourceForHome(home, { RAFT_DEPLOYMENT_MODE: "private" });
    assert.equal(unattached.backend, "hands");

    await attach(home, attachment(UUID_A, PRIVATE_ORIGIN, "internal"));
    const single = await resolveUpgradeSourceForHome(home, { RAFT_DEPLOYMENT_MODE: "private" });
    assert.equal(single.backend, "server");
    assert.equal(single.baseUrl, `${PRIVATE_ORIGIN}/downloads/computer`);

    // Multi-origin under the private default: a Computer upgrade is one
    // binary for the whole machine — refuse to pick a side (PM-required
    // regression test; the message must name the escape hatch).
    await attach(home, attachment(UUID_B, "https://other.internal.example", "other"));
    await assert.rejects(
      resolveUpgradeSourceForHome(home, { RAFT_DEPLOYMENT_MODE: "private" }),
      (error: unknown) =>
        error instanceof ComputerServiceError
        && error.message.includes("UPGRADE_SERVER_ORIGIN_AMBIGUOUS")
        && error.message.includes(UPGRADE_BASE_URL_ENV),
    );
  });
});

test("same-origin attachments collapse — duplicates and trailing slashes are one origin", async () => {
  await withHermeticHome(async (home) => {
    await attach(
      home,
      attachment(UUID_A, PRIVATE_ORIGIN, "internal"),
      attachment(UUID_B, `${PRIVATE_ORIGIN}/`, "internal-2"),
    );
    const base = await resolveServerDownloadsBase(home);
    assert.equal(base, `${PRIVATE_ORIGIN}/downloads/computer`);
  });
});
