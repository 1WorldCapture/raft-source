-- M4 human messaging foundation. Additive to the committed M3 0001-0009.
-- Unix millisecond timestamps and SQLite INTEGER counters. Message creation
-- seq is allocated inside the IMMEDIATE transaction, never in process memory.
CREATE UNIQUE INDEX idx_channels_id_workspace ON channels(id, workspace_id);
CREATE TABLE messages (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq > 0 AND seq <= 9007199254740991),
    id               TEXT NOT NULL UNIQUE,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_type      TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'external_projection')),
    sender_id        TEXT NOT NULL,
    content          TEXT NOT NULL,
    message_type     TEXT NOT NULL DEFAULT 'chat' CHECK (message_type IN ('chat', 'system')),
    random_id        TEXT,
    request_digest   TEXT NOT NULL,
    thread_id        TEXT REFERENCES channels(id) ON DELETE SET NULL,
    revision         INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision)='integer' AND revision>0 AND revision<=9007199254740991),
    created_at       INTEGER NOT NULL,
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id, workspace_id) REFERENCES channels(id, workspace_id)
);
CREATE UNIQUE INDEX idx_messages_sender_random
    ON messages(sender_type, sender_id, random_id) WHERE random_id IS NOT NULL;
CREATE INDEX idx_messages_workspace_seq ON messages(workspace_id, seq);
CREATE INDEX idx_messages_channel_seq ON messages(workspace_id, channel_id, seq);
CREATE INDEX idx_messages_sender ON messages(sender_type, sender_id);
CREATE UNIQUE INDEX idx_messages_id_workspace ON messages(id, workspace_id);

CREATE TABLE message_mentions (
    message_id       TEXT NOT NULL,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id, workspace_id) REFERENCES messages(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_message_mentions_user ON message_mentions(workspace_id, user_id, message_id);

CREATE TABLE message_reactions (
    message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji            TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_message_reactions_actor ON message_reactions(user_id, message_id);

-- Original client reducers order versions numerically; a hash of current
-- reactions is NOT a version (it may decrease or repeat after add/remove/add).
-- Shared discussions and private viewers have independent durable counters.
CREATE TABLE message_reaction_discussion_versions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version)='integer' AND version>=0 AND version<=9007199254740991),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(message_id,emoji)
);
CREATE TABLE message_reaction_viewer_versions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version)='integer' AND version>=0 AND version<=9007199254740991),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(message_id,user_id)
);
CREATE INDEX idx_message_reaction_viewer_versions_user ON message_reaction_viewer_versions(user_id);

-- Canonical human pair. user_low == user_high is a self-DM, with ONE roster
-- row. Channel workspace/type and participant membership are rechecked by
-- the owning channel use case inside the same transaction.
CREATE TABLE direct_messages (
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_low         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id       TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, user_low, user_high),
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
    CHECK (user_low <= user_high)
);
CREATE UNIQUE INDEX idx_channels_thread_parent
    ON channels(parent_message_id) WHERE type = 'thread' AND parent_message_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE thread_follows (
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    parent_message_id TEXT NOT NULL,
    followed_at      INTEGER NOT NULL,
    unfollowed_at    INTEGER,
    revision         INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision)='integer' AND revision>0 AND revision<=9007199254740991),
    PRIMARY KEY (workspace_id, user_id, thread_channel_id),
    FOREIGN KEY (thread_channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_message_id, workspace_id) REFERENCES messages(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_thread_follows_thread ON thread_follows(thread_channel_id, unfollowed_at, user_id);

-- Transactional publication intent, NOT a per-recipient delivery/ACK ledger.
-- Store references only. The publisher reprojects and reauthorizes against
-- current database facts; private payloads or stale recipient lists do not
-- enter this table. SubjectUserID is the owner of a private state object.
CREATE TABLE realtime_publications (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    object_type      TEXT NOT NULL,
    object_id        TEXT NOT NULL,
    event_type       TEXT NOT NULL,
    revision         INTEGER NOT NULL CHECK (revision > 0),
    subject_user_id  TEXT NOT NULL DEFAULT '',
    scope_id         TEXT NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL,
    published_at     INTEGER,
    attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (workspace_id, object_type, object_id, event_type, revision, subject_user_id)
);
CREATE INDEX idx_realtime_publications_pending
    ON realtime_publications(next_attempt_at, id) WHERE published_at IS NULL;
CREATE INDEX idx_realtime_publications_cleanup
    ON realtime_publications(published_at) WHERE published_at IS NOT NULL;
