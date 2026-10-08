-- 0001_init: account phase (M1A/M1B) schema for the independent Go server.
-- Timestamps are INTEGER unix milliseconds (UTC). Booleans are 0/1 integers.
-- Uniqueness on users.email/users.name is exact (case sensitive); email
-- normalization (trim + lowercase) happens in the auth service before write,
-- matching the legacy contract.

CREATE TABLE users (
    id                                   TEXT PRIMARY KEY,
    email                                TEXT NOT NULL UNIQUE,
    name                                 TEXT NOT NULL UNIQUE,
    display_name                         TEXT,
    description                          TEXT,
    avatar_url                           TEXT,
    email_verified                       INTEGER NOT NULL DEFAULT 0,
    password_hash                        TEXT NOT NULL,
    password_credential_established_at   INTEGER,
    preferred_language                   TEXT,
    display_language                     TEXT,
    preferred_timezone                   TEXT,
    first_observed_timezone              TEXT,
    first_observed_timezone_at           INTEGER,
    last_observed_timezone               TEXT,
    last_observed_timezone_at            INTEGER,
    auto_translation_enabled             INTEGER,
    preferred_translation_mode           TEXT CHECK (preferred_translation_mode IS NULL OR preferred_translation_mode IN ('auto','manual','off')),
    preferred_translation_display        TEXT CHECK (preferred_translation_display IS NULL OR preferred_translation_display IN ('translated','original','bilingual')),
    preferred_time_format                TEXT CHECK (preferred_time_format IS NULL OR preferred_time_format IN ('12h','24h')),
    preferred_message_body_font_size     TEXT CHECK (preferred_message_body_font_size IS NULL OR preferred_message_body_font_size IN ('sm','md','lg')),
    referral_source                      TEXT,
    referral_source_other                TEXT,
    referral_source_skipped_at           INTEGER,
    signup_role                          TEXT,
    signup_survey_completed_at           INTEGER,
    profile_setup_completed_at           INTEGER,
    profile_setup_suggested_handle       TEXT,
    created_at                           INTEGER NOT NULL,
    updated_at                           INTEGER NOT NULL
);

CREATE INDEX idx_users_created_at ON users(created_at);

CREATE TABLE session_families (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revoked_at     INTEGER,
    revoked_reason TEXT,
    created_at     INTEGER NOT NULL
);

CREATE INDEX idx_session_families_user ON session_families(user_id);

CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id  TEXT NOT NULL REFERENCES session_families(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_family ON sessions(family_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Hash lineage of consumed refresh tokens. Kept so a logout or replay
-- detection can still resolve the family an already-rotated token belonged to.
CREATE TABLE session_token_predecessors (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    family_id  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_predecessors_user ON session_token_predecessors(user_id);
CREATE INDEX idx_predecessors_expires ON session_token_predecessors(expires_at);

-- Durable rotation receipts: the AES-256-GCM sealed successor refresh token
-- for clients that bind their refresh attempts (attempt + installation ids).
-- Replay is honored only while the receipt is unexpired, the binding matches,
-- the successor session is alive and the family is not revoked.
CREATE TABLE session_refresh_rotation_receipts (
    id                       TEXT PRIMARY KEY,
    predecessor_token_hash   TEXT NOT NULL UNIQUE,
    predecessor_session_id   TEXT NOT NULL,
    user_id                  TEXT NOT NULL,
    family_id                TEXT NOT NULL,
    successor_session_id     TEXT NOT NULL,
    attempt_id               TEXT NOT NULL,
    installation_id          TEXT NOT NULL,
    successor_token_ciphertext TEXT NOT NULL,
    successor_token_iv       TEXT NOT NULL,
    successor_token_auth_tag TEXT NOT NULL,
    expires_at               INTEGER NOT NULL,
    created_at               INTEGER NOT NULL
);

CREATE INDEX idx_receipts_user ON session_refresh_rotation_receipts(user_id);
CREATE INDEX idx_receipts_expires ON session_refresh_rotation_receipts(expires_at);

-- One-shot account tokens (email verification, password reset). Only the
-- SHA-256 hash of the secret is persisted; consumption is a DELETE.
CREATE TABLE account_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('email_verification','password_reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_account_tokens_user ON account_tokens(user_id, kind, created_at);

-- Legal acceptance audit trail. Records which terms/privacy versions the
-- account accepted, when, from where (hashed evidence only).
CREATE TABLE legal_acceptances (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    terms_version   TEXT NOT NULL,
    privacy_version TEXT NOT NULL,
    terms_url       TEXT NOT NULL,
    privacy_url     TEXT NOT NULL,
    source          TEXT NOT NULL CHECK (source IN ('signup','oauth','invite')),
    ip_hash         TEXT,
    user_agent_hash TEXT,
    locale          TEXT,
    accepted_at     INTEGER NOT NULL
);

CREATE INDEX idx_legal_acceptances_user ON legal_acceptances(user_id);

-- Minimal workspace model so GET /api/servers is a REAL membership query.
-- Creation is deliberately absent until M2.
CREATE TABLE workspaces (
    id                       TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    slug                     TEXT NOT NULL UNIQUE,
    owner_id                 TEXT NOT NULL REFERENCES users(id),
    avatar_url               TEXT,
    onboarding_agent_id      TEXT,
    hide_humans_from_members INTEGER NOT NULL DEFAULT 0,
    plan                     TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','founder','partner')),
    plan_downgraded_at       INTEGER,
    created_at               INTEGER NOT NULL,
    deleted_at               INTEGER
);

CREATE TABLE workspace_memberships (
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role               TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','member','guest')),
    server_push_muted  INTEGER NOT NULL DEFAULT 0,
    joined_at          INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX idx_workspace_memberships_user ON workspace_memberships(user_id);
