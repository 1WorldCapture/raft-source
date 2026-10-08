-- M4 P5 human READSTATE / ACTIVITY schema DRAFT for migration 0011.
-- Authored by the readstate worker; the integrator reviews and copies this
-- file (verbatim or adjusted) into
-- internal/platform/db/migrations/0011_readstate_activity.sql. The statements
-- are idempotent (IF NOT EXISTS) so the readstate test fixture can apply this
-- exact file onto a database that already ran 0001-0010, with or without a
-- parent-added 0011.
--
-- Storage domain notes (frozen by docs/m4-activity-readstate-contract.md §3):
--   * Counters here are SQLite INTEGERs bounded by non-negative signed 64-bit.
--     Message seq is additionally CHECKed <= 2^53 by 0010, so every wire
--     value this module emits as a canonical UInt64 decimal string is exact.
--     Wire inputs larger than signed 64-bit are rejected/answered with
--     snapshotRequired by the Go package, never truncated.
--   * Timestamps are Unix milliseconds (same convention as 0010).
--   * Read state is the per-(workspace,user,channel) effective frontier:
--     maxReadSeq is monotonic for reads, an explicit unread rewinds it, and
--     every effective change bumps read_state_version ("same version must
--     map to the same value").
--   * Done state is one table for plain channels, human DMs and first-level
--     threads ("conversation Done state" in the contract table). It never
--     touches thread_follows rows (owned by the channel worker). A done row
--     only suppresses while the conversation's latest activity seq stays
--     <= done_through_activity_seq; newer activity reactivates the row.
--   * Mention suppression keeps the durable Done/unfollow boundary that caps
--     which human mentions can resurrect a row in the Mentions filter and
--     caps previews shown for unfollowed threads. target_kind mirrors the
--     legacy inbox_suppression_states vocabulary reduced to the M4 human
--     scope ('channel' covers public-channel mentions).
--   * The four activity_sync_* tables port the reference
--     packages/server/src/services/activitySyncService.ts mechanics:
--     a per-principal monotonic row_version authority shared across filters,
--     per-(filter,window) scopes with epoch/watermark, materialized window
--     rows with payload digests, and a bounded change journal (retention is
--     enforced by the Go package at 2048 changes; on overflow the scope rolls
--     its epoch instead of fabricating continuity).

-- 1. Effective conversation read state (wire: maxReadSeq / readStateVersion).
CREATE TABLE IF NOT EXISTS user_channel_read_states (
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_seq     INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
    read_state_version INTEGER NOT NULL DEFAULT 0 CHECK (read_state_version >= 0),
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_user_channel_read_states_user
    ON user_channel_read_states(workspace_id, user_id);

-- 2. Conversation Done state (plain channels, human DMs, first-level threads).
-- A row with done_at IS NOT NULL is a live Done; done_at IS NULL is the
-- caller-owned residue witness kept after undone. done_through_activity_seq
-- is monotonic (max of applied frontiers), never truncated to accept a
-- request. revision bumps on every actual transition.
CREATE TABLE IF NOT EXISTS user_channel_done_states (
    workspace_id              TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id                TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    done_through_activity_seq INTEGER NOT NULL DEFAULT 0
        CHECK (done_through_activity_seq >= 0),
    done_at                   INTEGER,
    active_override           INTEGER NOT NULL DEFAULT 0 CHECK (active_override IN (0, 1)),
    revision                  INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at                INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_user_channel_done_states_done
    ON user_channel_done_states(workspace_id, user_id, done_at);

-- 3. Durable mention/Done boundary (legacy inbox_suppression_states reduced
-- to the human M4 scope). Written by Done/unfollow-adjacent paths; read by
-- the Mentions filter and the unfollowed-thread projection.
CREATE TABLE IF NOT EXISTS user_mention_suppressions (
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_kind      TEXT NOT NULL CHECK (target_kind IN ('channel', 'dm', 'thread')),
    channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    done_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (done_through_seq >= 0),
    done_at          INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, target_kind, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_user_mention_suppressions_user
    ON user_mention_suppressions(workspace_id, user_id);

-- 4. Per-user human notification (activity mute) preferences. Independent
-- version domain from display prefs and from read state. mute_from_seq is
-- captured when muting (latest channel seq + 1); a personal mention or a
-- thread always pierces mute.
CREATE TABLE IF NOT EXISTS user_channel_mute_states (
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    activity_muted  INTEGER NOT NULL DEFAULT 0 CHECK (activity_muted IN (0, 1)),
    mute_from_seq   INTEGER,
    prefs_version   INTEGER NOT NULL DEFAULT 0 CHECK (prefs_version >= 0),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_user_channel_mute_states_user
    ON user_channel_mute_states(workspace_id, user_id);

-- 4b. Durable mute epochs. Eligibility is decided per message against the
-- epoch that was ACTIVE WHEN THE MESSAGE COMMITTED, not against the current
-- flag: an ordinary message sent while muted stays suppressed forever, and a
-- later unmute NEVER backfills it (the frozen inboxPolicyModel semantics:
-- "unmute does not backfill notification facts"). At unmute the open epoch is
-- closed with suppressed_through_seq = the channel's then-current max seq,
-- so the suppressed range is exactly the messages that committed while the
-- mute was active. Seq-based, immune to equal timestamps and restarts; an
-- empty epoch (suppressed_through = mute_from - 1) is a legitimate shape for
-- a mute with no traffic.
--
-- Keying (parent schema review): epoch_version derives from the mutating
-- transaction's prefs_version (monotonic per receiver/channel; version 0 is
-- reserved for the FROZEN IMPLICIT announcement prefix), NOT from the wall
-- clock — rapid mute/unmute/mute inside one millisecond cannot collide.
-- muted_at/unmuted_at stay real clock values for observability only. The
-- partial unique index enforces at most ONE open epoch per receiver/channel.
CREATE TABLE IF NOT EXISTS user_channel_mute_epochs (
    workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id             TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch_version          INTEGER NOT NULL CHECK (epoch_version >= 0),
    mute_from_seq          INTEGER NOT NULL CHECK (mute_from_seq >= 0),
    suppressed_through_seq INTEGER
        CHECK (suppressed_through_seq IS NULL OR suppressed_through_seq >= mute_from_seq - 1),
    muted_at               INTEGER NOT NULL,
    unmuted_at             INTEGER,
    PRIMARY KEY (workspace_id, user_id, channel_id, epoch_version)
);
CREATE INDEX IF NOT EXISTS idx_user_channel_mute_epochs_user
    ON user_channel_mute_epochs(workspace_id, user_id, channel_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_channel_mute_epochs_open
    ON user_channel_mute_epochs(workspace_id, user_id, channel_id)
    WHERE suppressed_through_seq IS NULL;

-- 5. Per-user message display preferences (independent version domain).
CREATE TABLE IF NOT EXISTS user_channel_display_prefs (
    workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id             TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    collapse_long_messages INTEGER NOT NULL DEFAULT 1 CHECK (collapse_long_messages IN (0, 1)),
    prefs_version          INTEGER NOT NULL DEFAULT 0 CHECK (prefs_version >= 0),
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_user_channel_display_prefs_user
    ON user_channel_display_prefs(workspace_id, user_id);

-- 6. Activity principal row-version authority. One monotonic counter per
-- (workspace, principal); every changed window row in ANY filter consumes the
-- next value, so the same row carries the same rowVersion across filters.
CREATE TABLE IF NOT EXISTS activity_principal_authorities (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    row_version  INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0),
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, principal_id)
);

-- 7. Activity scope cursor (user + workspace + filter + window). Not shared
-- with any other principal/filter/window. metadata is the frozen JSON window
-- metadata {nextCursor,hasMore,complete,totalCount,totalUnreadCount}.
CREATE TABLE IF NOT EXISTS activity_scopes (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    filter       TEXT NOT NULL CHECK (filter IN ('all', 'unread', 'mentions')),
    window_id    TEXT NOT NULL DEFAULT 'main',
    window_size  INTEGER NOT NULL DEFAULT 100 CHECK (window_size > 0),
    epoch        INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
    watermark    INTEGER NOT NULL DEFAULT 0 CHECK (watermark >= 0),
    scope_digest TEXT,
    metadata     TEXT,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, principal_id, filter, window_id),
    FOREIGN KEY (workspace_id, principal_id)
        REFERENCES activity_principal_authorities(workspace_id, principal_id)
        ON DELETE CASCADE
);

-- 8. Cross-filter row authority (last version + digest per row identity).
CREATE TABLE IF NOT EXISTS activity_row_authorities (
    workspace_id   TEXT NOT NULL,
    principal_id   TEXT NOT NULL,
    row_id         TEXT NOT NULL,
    last_version   INTEGER NOT NULL CHECK (last_version >= 0),
    active         INTEGER NOT NULL CHECK (active IN (0, 1)),
    payload_digest TEXT,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, principal_id, row_id),
    FOREIGN KEY (workspace_id, principal_id)
        REFERENCES activity_principal_authorities(workspace_id, principal_id)
        ON DELETE CASCADE
);

-- 9. Materialized window rows per scope. payload is the wire ActivityRow
-- JSON WITHOUT rowVersion (rowVersion is per-scope and stamped on read).
CREATE TABLE IF NOT EXISTS activity_rows (
    workspace_id     TEXT NOT NULL,
    principal_id     TEXT NOT NULL,
    filter           TEXT NOT NULL CHECK (filter IN ('all', 'unread', 'mentions')),
    window_id        TEXT NOT NULL DEFAULT 'main',
    row_id           TEXT NOT NULL,
    row_version      INTEGER NOT NULL CHECK (row_version >= 0),
    active           INTEGER NOT NULL CHECK (active IN (0, 1)),
    payload          TEXT,
    payload_digest   TEXT,
    tombstone_reason TEXT
        CHECK (tombstone_reason IS NULL OR tombstone_reason IN ('done', 'deleted', 'outOfWindow')),
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, principal_id, filter, window_id, row_id)
);
CREATE INDEX IF NOT EXISTS idx_activity_rows_scope
    ON activity_rows(workspace_id, principal_id, filter, window_id, active);

-- 10. Bounded change journal per scope. seq is dense per scope from 1; the
-- Go package enforces the 2048-change retention and rolls the epoch when the
-- journal would overflow rather than leaving a hole.
CREATE TABLE IF NOT EXISTS activity_changes (
    workspace_id     TEXT NOT NULL,
    principal_id     TEXT NOT NULL,
    filter           TEXT NOT NULL CHECK (filter IN ('all', 'unread', 'mentions')),
    window_id        TEXT NOT NULL DEFAULT 'main',
    seq              INTEGER NOT NULL CHECK (seq > 0),
    row_id           TEXT,
    row_version      INTEGER,
    kind             TEXT NOT NULL CHECK (kind IN ('upsert', 'tombstone', 'scope')),
    payload          TEXT,
    tombstone_reason TEXT,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, principal_id, filter, window_id, seq)
);
