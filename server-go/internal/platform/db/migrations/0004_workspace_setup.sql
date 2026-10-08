-- 0004_workspace_setup: M2 setup-worker slice.
--
-- Owns: per-member durable setup state, the minimal REAL machine/computer
-- catalog, the minimal agent directory (read boundary only; no product
-- registration or agent writer in M2), and the account-level first-onboarding
-- facts used by setup-handoff. Survey facts already exist on users
-- (signup_survey_completed_at, 0001) and are reused, not duplicated.
--
-- Conventions follow 0001: timestamps are INTEGER unix milliseconds (UTC),
-- booleans are 0/1 integers, UUIDs are TEXT. TS physical table names
-- (daemons/computers/agents/server_agent_members) are not required; the
-- mapping is documented in docs/m2-directory-schema.md.
--
-- Ordering contract: this migration runs after 0003_workspace_foundation.
-- workspace_member_setup carries a composite foreign key into
-- workspace_memberships, so 0003's membership rebuild must never run on a
-- database that already applied 0004 (fresh installs order naturally;
-- do not keep intermediate databases built from the setup slice alone).

-- Per-member durable setup state (TS: server_members.setup_* columns).
-- setup is a fact about one membership, not a workspace-wide boolean.
-- 'deferred' is legacy-read-only: the runtime never produces it anymore
-- (task #172), but old rows must still read as non-blocking.
CREATE TABLE workspace_member_setup (
    workspace_id            TEXT NOT NULL,
    user_id                 TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (status IN ('not_started','in_progress','deferred','complete')),
    completion_reason       TEXT
                            CHECK (completion_reason IS NULL
                                   OR (completion_reason IN ('normal','grandfathered','complete_after_defer','admin_override')
                                       AND status = 'complete')),
    contract_version        TEXT NOT NULL,
    handoff_acknowledged_at INTEGER,
    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_memberships(workspace_id, user_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_workspace_member_setup_user ON workspace_member_setup(user_id);

-- Backfill setup rows for every existing membership. Honest default: M1
-- members never went through onboarding, so they are not_started under the
-- current contract. Old owners are NEVER auto-completed here; completion
-- still happens only through the real write paths (explicit transition,
-- authorized onboarding-agent setter reconcile).
INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version)
SELECT workspace_id, user_id, 'not_started', NULL, 'onboarding-setup-v2'
FROM workspace_memberships;

-- Minimal machine catalog (TS table `daemons`). Read-only in M2: no
-- registration, connection, runtime probe or credential writer. api_key
-- hash/fingerprint columns are intentionally absent until the M3 admission
-- flow exists (do not persist secrets nothing verifies). `runtimes` is a
-- JSON array of runtime ids; NULL means "not reported yet" (TS semantic that
-- feeds runtimeStatus=unknown). last_status/status_changed_at persist the
-- last settled connection state; the LIVE status still comes from a
-- connection layer M2 does not have, so readers must treat unprovable
-- online-ness as unknown/offline rather than fabricating "online".
CREATE TABLE machines (
    id                          TEXT PRIMARY KEY,
    workspace_id                TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id                     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                        TEXT NOT NULL,
    description                 TEXT,
    api_key_prefix              TEXT,
    runtimes                    TEXT,
    hostname                    TEXT,
    os                          TEXT,
    daemon_version              TEXT,
    computer_version            TEXT,
    computer_version_reported_at INTEGER,
    last_heartbeat              INTEGER,
    last_status                 TEXT CHECK (last_status IS NULL OR last_status IN ('online','offline')),
    status_changed_at           INTEGER,
    created_at                  INTEGER NOT NULL
);

CREATE INDEX idx_machines_workspace ON machines(workspace_id, created_at);

-- Minimal managed-Computer catalog (TS `computers`). The non-revoked rows of
-- this table ARE "has connected a computer" — a durable fact that does not
-- change when the machine sleeps. No api-key columns in M2 (no attach flow).
CREATE TABLE computers (
    id                 TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    attached_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    machine_id         TEXT REFERENCES machines(id) ON DELETE SET NULL,
    created_at         INTEGER NOT NULL,
    last_used_at       INTEGER,
    revoked_at         INTEGER,
    revoked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_reason     TEXT
);

CREATE INDEX idx_computers_workspace ON computers(workspace_id);
CREATE INDEX idx_computers_machine ON computers(machine_id);
CREATE INDEX idx_computers_active_prefix ON computers(workspace_id)
    WHERE revoked_at IS NULL;

-- Minimal agent directory (TS `agents`). M2 only READS this table: the
-- official onboarding-agent identity check, the onboarding-settings setter
-- validation, machine agent counts and sidebar sanitization. The product has
-- no agent writer yet; valid rows exist only in isolated test fixtures.
CREATE TABLE agents (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    display_name  TEXT,
    description   TEXT,
    avatar_url    TEXT,
    status        TEXT NOT NULL DEFAULT 'inactive'
                  CHECK (status IN ('active','inactive','stopped')),
    runtime       TEXT NOT NULL DEFAULT 'claude',
    machine_id    TEXT REFERENCES machines(id) ON DELETE SET NULL,
    creator_type  TEXT CHECK (creator_type IS NULL OR creator_type IN ('user','agent')),
    creator_id    TEXT,
    deleted_at    INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_agents_workspace ON agents(workspace_id);
CREATE UNIQUE INDEX idx_agents_workspace_name ON agents(workspace_id, name)
    WHERE deleted_at IS NULL;

-- Agent↔workspace membership role (TS `server_agent_members`). Only
-- 'admin' here satisfies the official onboarding-agent identity check.
CREATE TABLE agent_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
    joined_at    INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, agent_id)
);

CREATE INDEX idx_agent_members_agent ON agent_members(agent_id);

-- Account-level first-onboarding facts written by setup-handoff ("Let's Go").
-- First-write-wins: only the first final handoff defines the account gate,
-- and repeated clicks never refresh the first timestamp.
ALTER TABLE users ADD COLUMN first_onboarding_completed_at INTEGER;
ALTER TABLE users ADD COLUMN first_onboarding_completed_session_family_id TEXT;
