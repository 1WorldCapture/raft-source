-- 0003_workspace_foundation: M2 foundation schema (design §6).
-- Timestamps stay INTEGER unix milliseconds (UTC); booleans stay 0/1 integers.
-- This migration owns: real workspace configuration columns, the membership
-- default-role rebuild, the membership agreement audit, channels/channel_humans,
-- and the account-level switcher order. It deliberately does NOT create
-- workspace_member_setup / workspace_member_preferences (migrations 0004/0005).

-- 1. workspaces: TS `servers` parity columns. Existing rows read as
-- kind='normal', greeting on, everything else off. SQLite ADD COLUMN on a
-- populated M1 table needs a constant default; backfill updated_at from each
-- row's real creation timestamp. Every M2 product writer sets it explicitly.
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'
    CHECK (kind IN ('normal', 'joint_storage'));
ALTER TABLE workspaces ADD COLUMN agent_all_channel_greeting_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspaces ADD COLUMN publicly_visible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN translation_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN progress_announcements_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE workspaces SET updated_at = created_at;

-- 2. Membership default-role fix (design §6.3, D05): future inserts default
-- to member; the creator writes 'owner' explicitly. Rows are preserved
-- as-is via the rehearsed table-rebuild path. The original M1 schema has no
-- table holding a foreign key INTO workspace_memberships, so the
-- rebuild needs no PRAGMA foreign_keys toggle; the migration runner's
-- foreign_key_check still validates the result before commit.
CREATE TABLE workspace_memberships_rebuilt (
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    server_push_muted  INTEGER NOT NULL DEFAULT 0,
    joined_at          INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);
INSERT INTO workspace_memberships_rebuilt (workspace_id, user_id, role, server_push_muted, joined_at)
    SELECT workspace_id, user_id, role, server_push_muted, joined_at FROM workspace_memberships;
DROP TABLE workspace_memberships;
ALTER TABLE workspace_memberships_rebuilt RENAME TO workspace_memberships;
CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);

-- 3. Membership agreement audit (TS server_membership_agreement_audit).
-- Records real acceptance facts only: creation writes source='admin-add'
-- with NULL agreement/version — no fabricated acceptance.
CREATE TABLE workspace_membership_agreement_audit (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    subject_type      TEXT NOT NULL CHECK (subject_type IN ('user', 'agent')),
    subject_id        TEXT NOT NULL,
    agreement_id      TEXT,
    agreement_version INTEGER,
    actor_user_id     TEXT NOT NULL REFERENCES users(id),
    source            TEXT NOT NULL CHECK (source IN ('invite', 'join', 'request-access', 'admin-add')),
    ip_address        TEXT,
    user_agent        TEXT,
    signature_method  TEXT,
    signature_payload TEXT,
    created_at        INTEGER NOT NULL
);
CREATE INDEX idx_workspace_agreement_audit_workspace
    ON workspace_membership_agreement_audit(workspace_id);
CREATE INDEX idx_workspace_agreement_audit_subject
    ON workspace_membership_agreement_audit(subject_type, subject_id);

-- 4. Channels (TS `channels`, M2 scope: system channels and the opener's
-- private channel only — no CRUD/read surfaces here). archived_by_agent_id
-- keeps the TS column without a foreign key until the agent table exists;
-- the future agent module owns that reference. Partial unique indexes
-- arbitrate concurrent retries so #all/#announcement cannot double-create;
-- name uniqueness spans archived-but-not-deleted channels.
CREATE TABLE channels (
    id                   TEXT PRIMARY KEY,
    workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    description          TEXT,
    type                 TEXT NOT NULL DEFAULT 'channel' CHECK (type IN ('channel', 'private', 'joint', 'dm', 'thread')),
    system_kind          TEXT CHECK (system_kind IS NULL OR system_kind IN ('all', 'announcement')),
    guest_visible        INTEGER NOT NULL DEFAULT 0,
    guest_joinable       INTEGER NOT NULL DEFAULT 0,
    parent_message_id    TEXT,
    created_at           INTEGER NOT NULL,
    archived_at          INTEGER,
    archived_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    archived_by_agent_id TEXT,
    deleted_at           INTEGER,
    CHECK (guest_joinable = 0 OR guest_visible = 1)
);
CREATE INDEX idx_channels_workspace ON channels(workspace_id);
CREATE UNIQUE INDEX idx_channels_workspace_name_type ON channels(workspace_id, name)
    WHERE type IN ('channel', 'private', 'joint') AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_channels_workspace_system_kind ON channels(workspace_id, system_kind)
    WHERE system_kind IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_channels_archived ON channels(workspace_id, archived_at);

-- 5. Human channel roster (TS channel_humans). Only the opener's private
-- onboarding channel needs an explicit owner roster in M2.
CREATE TABLE channel_humans (
    channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    authority_revision INTEGER NOT NULL DEFAULT 1,
    joined_at          INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_channel_humans_user ON channel_humans(user_id);
CREATE INDEX idx_channel_humans_channel_role ON channel_humans(channel_id, role);

-- 6. Account-level switcher order (TS stores this on users; the Go design
-- keeps accounts untouched and stores the projection per user instead).
-- server_order is a JSON array of workspace IDs; version is monotonic.
CREATE TABLE account_workspace_order (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    server_order TEXT NOT NULL DEFAULT '[]',
    version      INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);
