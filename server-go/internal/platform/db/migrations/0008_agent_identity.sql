-- 0008_agent_identity: M3B agent-worker slice.
--
-- Owns: the agent identity/binding/lifecycle columns the TS `agents` table
-- carries beyond the M2 read-only directory (0004), the `sk_agent_*`
-- credential catalog, the single-use bootstrap-token catalog, and (in the
-- machine-command companion below) the durable pending-purge rows written by
-- agent deletion. It deliberately does NOT create channels/channel_agents
-- (0003 + 0006), machines/computers admission columns (0004 + 0007),
-- messages, or agent activity/scope tables (M4+).
--
-- Conventions follow 0001/0003/0004: timestamps are INTEGER unix
-- milliseconds (UTC), booleans are 0/1 integers, UUIDs are TEXT, JSON values
-- are TEXT holding canonical JSON.
--
-- Column mapping vs TS schema.ts `agents`: machine binding stays the Go name
-- machine_id (0004; TS physical column daemon_id), workspace stays
-- workspace_id (TS server_id). TS columns deliberately NOT added here:
-- all_channel_intro_sent_at (M5 greeting delivery), last_runtime_error
-- (runtime error projection, M4+), runtime-profile migration columns
-- (deferred joint/migration work).

-- 1. agents: identity/binding/lifecycle columns the M3B writer owns.
-- Existing M2 rows read as the TS defaults: model 'sonnet' is the historical
-- schema default; runtime-specific defaults are applied by the product writer.
ALTER TABLE agents ADD COLUMN status_changed_at INTEGER;
ALTER TABLE agents ADD COLUMN session_id TEXT;
ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT 'sonnet';
ALTER TABLE agents ADD COLUMN runtime_config TEXT;
ALTER TABLE agents ADD COLUMN reasoning_effort TEXT
    CHECK (reasoning_effort IS NULL
           OR reasoning_effort IN ('low','medium','high','xhigh','max','ultra'));
ALTER TABLE agents ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'byoc'
    CHECK (execution_mode IN ('byoc','cloud'));
ALTER TABLE agents ADD COLUMN env_vars TEXT;
-- Baseline for pre-existing rows: a lifecycle transition always has a since
-- stamp (TS backfilled from lifecycle events; the honest Go equivalent for
-- fixture rows is the row's own creation clock).
UPDATE agents SET status_changed_at = created_at WHERE status_changed_at IS NULL;
CREATE INDEX idx_agents_creator ON agents(workspace_id, creator_type, creator_id);

-- 2. agent_credentials — `sk_agent_*` runtime principals (TS table
-- agent_credentials). One row per credential, bound to exactly one agent for
-- life; rows are never deleted (revocation is the terminal state). The raw
-- key is returned exactly once at mint; only the argon2id hash and a lookup
-- prefix persist. scopes is a JSON array of capability literals.
CREATE TABLE agent_credentials (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    api_key_hash        TEXT NOT NULL,
    api_key_prefix      TEXT NOT NULL,
    name                TEXT,
    scopes              TEXT NOT NULL,
    created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at          INTEGER NOT NULL,
    last_used_at        INTEGER,
    last_used_ip        TEXT,
    last_used_user_agent TEXT,
    revoked_at          INTEGER,
    revoked_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_reason      TEXT
);

CREATE INDEX idx_agent_credentials_prefix ON agent_credentials(api_key_prefix);
CREATE INDEX idx_agent_credentials_agent ON agent_credentials(agent_id);
-- Hot auth path: candidates for prefix lookup exclude revoked rows.
CREATE INDEX idx_agent_credentials_prefix_active ON agent_credentials(api_key_prefix)
    WHERE revoked_at IS NULL;

-- 3. agent_bootstrap_tokens — single-use mint tokens (TS table
-- agent_bootstrap_tokens). token_lookup_hash is HMAC-SHA256(pepper, raw) as
-- BLOB and locates the row at exchange time; token_hash is the argon2id
-- verifier. TTL default is 30 minutes (product writer). Rows are never
-- deleted; consume and revoke are terminal states.
CREATE TABLE agent_bootstrap_tokens (
    id                     TEXT PRIMARY KEY,
    token_lookup_hash      BLOB NOT NULL UNIQUE,
    token_hash             TEXT NOT NULL,
    token_prefix           TEXT NOT NULL,
    target_agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    issued_by_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes                 TEXT NOT NULL,
    ttl_expires_at         INTEGER NOT NULL,
    consumed_at            INTEGER,
    consumed_credential_id TEXT,
    consumed_ip            TEXT,
    consumed_user_agent    TEXT,
    revoked_at             INTEGER,
    revoked_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_reason         TEXT,
    created_at             INTEGER NOT NULL
);

CREATE INDEX idx_agent_bootstrap_tokens_agent ON agent_bootstrap_tokens(target_agent_id);
CREATE INDEX idx_agent_bootstrap_tokens_workspace ON agent_bootstrap_tokens(workspace_id);

-- 4. machine_pending_agent_purges — durable local-state purge intents (TS
-- table machine_pending_agent_purges). Written transactionally by agent
-- deletion; dispatched to the machine when it is (re)connected and removed
-- when the daemon reports a terminal outcome. Survives the machine being
-- offline at delete time.
CREATE TABLE machine_pending_agent_purges (
    machine_id       TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at  INTEGER,
    last_outcome     TEXT,
    PRIMARY KEY (machine_id, agent_id)
);

CREATE INDEX idx_machine_pending_agent_purges_machine ON machine_pending_agent_purges(machine_id);

-- 5. #all unlock-instruction claim (TS serverMembers.
-- allChannelUnlockInstructionSentAt). The #all reveal in agent creation and
-- the /system/all/hide surface (CHANNEL worker) guard on this stamp; it is
-- written only when the unlock instruction is actually delivered (M5), so
-- NULL means "not yet sent" for every existing row.
ALTER TABLE workspace_member_setup ADD COLUMN all_channel_unlock_instruction_sent_at INTEGER;
