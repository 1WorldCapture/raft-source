-- 0007_computer_admission: M3 COMPUTER worker slice.
--
-- Owns: legacy machine credentials (TS `daemons` api-key columns deferred by
-- 0004 "until the M3 admission flow exists"), Computer `sk_computer_*`
-- credential columns on `computers`, and the device-code user-login grant
-- table (TS `device_authorizations`).
--
-- Conventions follow 0001: timestamps are INTEGER unix milliseconds (UTC),
-- booleans are 0/1 integers, UUIDs are TEXT. This migration is purely
-- additive against M1/M2 databases: every added column is nullable, so rows
-- created before admission read as "no credential yet" and never authorize.
-- No behavior of migrations 0001-0005 changes.

-- machines (TS `daemons`) credential columns. `api_key_prefix` already exists
-- (0004); only the indexes are added here. `api_key_fingerprint` is
-- sha256(raw key) hex truncated to 16 chars: the RFC v9.9 §X.2 intersection
-- key shared with on-disk daemon owner.json. SECRET REDLINE: derived from the
-- raw key; treat as sensitive identity, never log.
ALTER TABLE machines ADD COLUMN api_key_hash TEXT;
ALTER TABLE machines ADD COLUMN api_key_fingerprint TEXT;
-- Set when the legacy key is adopted into a Computer attachment; a migrated
-- key stops authorizing /daemon/connect (TS legacy_machine_key_migrated).
ALTER TABLE machines ADD COLUMN legacy_key_migrated_at INTEGER;

CREATE INDEX idx_machines_api_key_prefix ON machines(api_key_prefix);
CREATE INDEX idx_machines_api_key_fingerprint ON machines(api_key_fingerprint);

-- computers (TS `computers`) credential columns, same contract as the TS
-- table: argon2id hash of the raw sk_computer_* key plus its first 16 chars
-- for indexed lookup. Revocation keeps using the existing revoked_at column.
ALTER TABLE computers ADD COLUMN api_key_hash TEXT;
ALTER TABLE computers ADD COLUMN api_key_prefix TEXT;

CREATE INDEX idx_computers_prefix ON computers(api_key_prefix);

-- device_authorizations (TS `device_authorizations`): the device-code
-- user-login grant behind POST /api/auth/device/{authorize,approve,token}.
-- device_code_lookup_hash is HMAC-SHA256(pepper, raw device_code) as raw
-- bytes (deterministic + unique, locates the row at poll time);
-- device_code_hash is the argon2id verifier checked after location. Rows are
-- NEVER deleted; state transitions are soft (pending/approved/denied/
-- expired/consumed) with single-consume CAS on status='approved'.
CREATE TABLE device_authorizations (
    id                      TEXT PRIMARY KEY,
    device_code_lookup_hash BLOB NOT NULL UNIQUE,
    device_code_hash        TEXT NOT NULL,
    user_code               TEXT NOT NULL UNIQUE,
    status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','denied','expired','consumed')),
    client_name             TEXT,
    approved_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at              INTEGER NOT NULL,
    poll_interval_seconds   INTEGER NOT NULL DEFAULT 5,
    approved_at             INTEGER,
    denied_at               INTEGER,
    consumed_at             INTEGER,
    consumed_session_id     TEXT,
    consumed_ip             TEXT,
    consumed_user_agent     TEXT,
    revoked_at              INTEGER,
    revoked_by_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_reason          TEXT,
    created_at              INTEGER NOT NULL
);

CREATE INDEX idx_device_authorizations_approved_by ON device_authorizations(approved_by_user_id);
CREATE INDEX idx_device_authorizations_expires_at ON device_authorizations(expires_at);

-- Computer last-use observability triple (TS computers columns): the
-- best-effort write happens on every sk_computer_* authenticated request.
ALTER TABLE computers ADD COLUMN last_used_ip TEXT;
ALTER TABLE computers ADD COLUMN last_used_user_agent TEXT;
