import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_EXTERNAL_AGENT_CAPABILITIES } from "@botiverse/raft-shared";

/**
 * Task #8 evidence (PM review of #361): the seven least-privilege scopes
 * must cover every agent-api endpoint the CLI calls with an agent
 * credential. This table is the command -> endpoint -> capability audit;
 * it fails the moment a CLI command starts calling an endpoint whose
 * capability is not in DEFAULT_EXTERNAL_AGENT_CAPABILITIES, forcing an
 * explicit decision (extend the CLI scopes, or mark the command as
 * deliberately unsupported for external agent credentials).
 *
 * Source of truth for capabilities: packages/shared/src/agentApiContract.ts
 * (plus the raw routes in routes/internalAgentApi.ts that sit outside the
 * contract register — channel create/update/members are `channels`).
 */

type Cap = (typeof DEFAULT_EXTERNAL_AGENT_CAPABILITIES)[number] | "server" | "mcp";

interface CliEndpointUse {
  command: string;
  method: string;
  endpoint: string;
  capability: Cap;
  /** Present only on DELIBERATELY_OUTSIDE entries. */
  reason?: string;
}

/** Every agent-api endpoint a CLI command calls (audit 2026-10-11). */
const CLI_AGENT_ENDPOINT_USES: readonly CliEndpointUse[] = [
  // messaging
  { command: "message send", method: "POST", endpoint: "/send", capability: "send" },
  { command: "message send", method: "POST", endpoint: "/v2/send", capability: "send" },
  { command: "message read", method: "GET", endpoint: "/history", capability: "read" },
  { command: "message search", method: "GET", endpoint: "/search", capability: "read" },
  { command: "message resolve", method: "GET", endpoint: "/messages/:id/resolve", capability: "read" },
  // channels & threads
  { command: "channel create", method: "POST", endpoint: "/channels", capability: "channels" },
  { command: "channel update", method: "PATCH", endpoint: "/channels/:channelId", capability: "channels" },
  { command: "channel add-member", method: "POST", endpoint: "/channels/:channelId/members", capability: "channels" },
  { command: "channel remove-member", method: "DELETE", endpoint: "/channels/:channelId/members", capability: "channels" },
  { command: "channel archive", method: "POST", endpoint: "/channels/archive", capability: "channels" },
  { command: "channel join/leave/mute/unmute", method: "POST", endpoint: "/channels/:channelId/{join,leave,mute,unmute}", capability: "channels" },
  { command: "channel members", method: "GET", endpoint: "/channel-members", capability: "channels" },
  { command: "thread unfollow", method: "POST", endpoint: "/threads/unfollow", capability: "channels" },
  // tasks & reminders
  { command: "task *", method: "*", endpoint: "/tasks*", capability: "tasks" },
  { command: "reminder *", method: "*", endpoint: "/reminders*", capability: "tasks" },
  { command: "prepare-action", method: "POST", endpoint: "/prepare-action", capability: "tasks" },
  // mentions
  { command: "mention pending/execute", method: "*", endpoint: "/mention-actions/*", capability: "mentions" },
  // reactions
  { command: "reaction add/remove", method: "*", endpoint: "/messages/:id/reactions", capability: "reactions" },
  // knowledge & wiki
  { command: "knowledge get / manual get", method: "GET", endpoint: "/knowledge", capability: "knowledge" },
  { command: "wiki get/publish", method: "*", endpoint: "/wiki/*", capability: "knowledge" },
  // attachments: view under read, upload under send
  { command: "attachment view/comments", method: "GET", endpoint: "/attachments/:id[/comments]", capability: "read" },
  { command: "attachment upload", method: "POST", endpoint: "/upload + /attachment-upload-sessions*", capability: "send" },
  // integrations: read-side discovery AND the Raft Agent Login manage verbs
  // both sit under the `read` capability in the upstream contract.
  { command: "integration list/marketplace/app", method: "GET", endpoint: "/integrations*", capability: "read" },
  { command: "integration login/manage", method: "POST", endpoint: "/integrations/login|app/*", capability: "read" },
  // events / inbox
  { command: "inbox drain / events", method: "GET", endpoint: "/events* (+ /events/ack)", capability: "read" },
  // profile: show under read; own-profile WRITE re-filed under send by the
  // upstream 1.21.2 port (task #8 review) — upstream files an agent editing
  // its own profile/avatar under `send`.
  { command: "profile show", method: "GET", endpoint: "/profile", capability: "read" },
  { command: "profile update", method: "POST", endpoint: "/profile (+ /profile/avatar)", capability: "send" },
  // agent startup discovery: GET /server lists channels/agents/humans visible
  // to the bound agent; upstream 1.21.2 files it under `read` (was `server`
  // in our v1.13 fork). Server ADMINISTRATION stays `server` (OUTSIDE list).
  { command: "server info", method: "GET", endpoint: "/server", capability: "read" },
  // migration status polling (initiating a migration is `server` — OUTSIDE)
  { command: "migrate status", method: "GET", endpoint: "/migrations/current", capability: "read" },
  // misc
  { command: "app config", method: "*", endpoint: "/apps/:appId/config", capability: "tasks" },
  { command: "resolve-channel", method: "POST", endpoint: "/resolve-channel", capability: "send" },
  { command: "feedback-locators", method: "*", endpoint: "/feedback-locators", capability: "send" },
  { command: "send-receipts", method: "GET", endpoint: "/send-receipts/:key", capability: "read" },
];

/**
 * CLI commands that intentionally require MORE than the least-privilege set.
 * They keep working for credentials that were issued explicitly with the
 * extra scope; a plain `agent login` credential is rejected by the server
 * with an authorization error. Deliberate (task #8 review, PM): adding
 * `server`/`mcp` to every CLI login would defeat the least-privilege
 * default for the common case.
 */
const DELIBERATELY_OUTSIDE: readonly CliEndpointUse[] = [
  { command: "server update", method: "PATCH", endpoint: "/server (+ /server/avatar)", capability: "server",
    reason: "server administration stays `server` in the upstream contract too" },
  { command: "agent migrate", method: "POST", endpoint: "/migrations", capability: "server",
    reason: "cross-computer agent migration is an operator action (upstream has no such agent route)" },
  { command: "mcp tools/call", method: "*", endpoint: "/mcp/*", capability: "mcp",
    reason: "managed MCP calls spend server-held provider credentials" },
];

test("every CLI agent endpoint use is covered by the least-privilege scopes", () => {
  const covered = new Set<string>(DEFAULT_EXTERNAL_AGENT_CAPABILITIES);
  for (const use of CLI_AGENT_ENDPOINT_USES) {
    assert.ok(
      covered.has(use.capability as string),
      `${use.command} -> ${use.method} ${use.endpoint} needs '${use.capability}', ` +
      `which is NOT in DEFAULT_EXTERNAL_AGENT_CAPABILITIES. Either extend the CLI scopes ` +
      `deliberately or add the command to DELIBERATELY_OUTSIDE.`,
    );
  }
});

test("the out-of-scope commands are a conscious, documented list", () => {
  assert.equal(DELIBERATELY_OUTSIDE.length, 3);
  for (const use of DELIBERATELY_OUTSIDE) {
    assert.ok(
      use.reason,
      `${use.command} must carry a reason for staying outside the least-privilege set`,
    );
  }
});
