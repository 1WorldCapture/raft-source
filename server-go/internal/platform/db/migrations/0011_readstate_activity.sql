-- M4 personal read/Done/mute/display state and durable Activity windows.
-- Reviewed from contracts/m4-readstate-schema.sql. Unlike that replayable test
-- draft this migration fails on existing-table drift, and all private window
-- rows/journal entries cascade with their owning user/workspace scope.
CREATE TABLE user_channel_read_states (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (typeof(last_read_seq)='integer' AND last_read_seq>=0),
    read_state_version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(read_state_version)='integer' AND read_state_version>=0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,user_id,channel_id),
    FOREIGN KEY (channel_id,workspace_id) REFERENCES channels(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_channel_read_states_user ON user_channel_read_states(workspace_id,user_id);

CREATE TABLE user_channel_done_states (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    done_through_activity_seq INTEGER NOT NULL DEFAULT 0 CHECK (typeof(done_through_activity_seq)='integer' AND done_through_activity_seq>=0),
    done_at INTEGER,
    active_override INTEGER NOT NULL DEFAULT 0 CHECK (active_override IN (0,1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision)='integer' AND revision>0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,user_id,channel_id),
    FOREIGN KEY (channel_id,workspace_id) REFERENCES channels(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_channel_done_states_done ON user_channel_done_states(workspace_id,user_id,done_at);

CREATE TABLE user_mention_suppressions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('channel','dm','thread')),
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    done_through_seq INTEGER NOT NULL DEFAULT 0 CHECK (typeof(done_through_seq)='integer' AND done_through_seq>=0),
    done_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,user_id,target_kind,channel_id),
    FOREIGN KEY (channel_id,workspace_id) REFERENCES channels(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_mention_suppressions_user ON user_mention_suppressions(workspace_id,user_id);

CREATE TABLE user_channel_mute_states (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    activity_muted INTEGER NOT NULL DEFAULT 1 CHECK (activity_muted IN (0,1)),
    mute_from_seq INTEGER CHECK (mute_from_seq IS NULL OR (typeof(mute_from_seq)='integer' AND mute_from_seq>=0)),
    prefs_version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(prefs_version)='integer' AND prefs_version>=0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,user_id,channel_id),
    FOREIGN KEY (channel_id,workspace_id) REFERENCES channels(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_channel_mute_states_user ON user_channel_mute_states(workspace_id,user_id);

CREATE TABLE user_channel_display_prefs (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    collapse_long_messages INTEGER NOT NULL DEFAULT 1 CHECK (collapse_long_messages IN (0,1)),
    prefs_version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(prefs_version)='integer' AND prefs_version>=0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,user_id,channel_id),
    FOREIGN KEY (channel_id,workspace_id) REFERENCES channels(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_channel_display_prefs_user ON user_channel_display_prefs(workspace_id,user_id);

CREATE TABLE activity_principal_authorities (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    principal_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    row_version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(row_version)='integer' AND row_version>=0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,principal_id)
);

CREATE TABLE activity_scopes (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    filter TEXT NOT NULL CHECK (filter IN ('all','unread','mentions')),
    window_id TEXT NOT NULL DEFAULT 'main',
    window_size INTEGER NOT NULL DEFAULT 100 CHECK (window_size>0),
    epoch INTEGER NOT NULL DEFAULT 1 CHECK (typeof(epoch)='integer' AND epoch>0),
    watermark INTEGER NOT NULL DEFAULT 0 CHECK (typeof(watermark)='integer' AND watermark>=0),
    scope_digest TEXT,
    metadata TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,principal_id,filter,window_id),
    FOREIGN KEY (workspace_id,principal_id) REFERENCES activity_principal_authorities(workspace_id,principal_id) ON DELETE CASCADE
);

CREATE TABLE activity_row_authorities (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    last_version INTEGER NOT NULL CHECK (typeof(last_version)='integer' AND last_version>=0),
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    payload_digest TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,principal_id,row_id),
    FOREIGN KEY (workspace_id,principal_id) REFERENCES activity_principal_authorities(workspace_id,principal_id) ON DELETE CASCADE
);

CREATE TABLE activity_rows (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    filter TEXT NOT NULL CHECK (filter IN ('all','unread','mentions')),
    window_id TEXT NOT NULL DEFAULT 'main',
    row_id TEXT NOT NULL,
    row_version INTEGER NOT NULL CHECK (typeof(row_version)='integer' AND row_version>=0),
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    payload TEXT,
    payload_digest TEXT,
    tombstone_reason TEXT CHECK (tombstone_reason IS NULL OR tombstone_reason IN ('done','deleted','outOfWindow')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,principal_id,filter,window_id,row_id),
    FOREIGN KEY (workspace_id,principal_id,filter,window_id) REFERENCES activity_scopes(workspace_id,principal_id,filter,window_id) ON DELETE CASCADE
);
CREATE INDEX idx_activity_rows_scope ON activity_rows(workspace_id,principal_id,filter,window_id,active);

CREATE TABLE activity_changes (
    workspace_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    filter TEXT NOT NULL CHECK (filter IN ('all','unread','mentions')),
    window_id TEXT NOT NULL DEFAULT 'main',
    seq INTEGER NOT NULL CHECK (typeof(seq)='integer' AND seq>0),
    row_id TEXT,
    row_version INTEGER CHECK (row_version IS NULL OR (typeof(row_version)='integer' AND row_version>=0)),
    kind TEXT NOT NULL CHECK (kind IN ('upsert','tombstone','scope')),
    payload TEXT,
    tombstone_reason TEXT CHECK (tombstone_reason IS NULL OR tombstone_reason IN ('done','deleted','outOfWindow')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id,principal_id,filter,window_id,seq),
    FOREIGN KEY (workspace_id,principal_id,filter,window_id) REFERENCES activity_scopes(workspace_id,principal_id,filter,window_id) ON DELETE CASCADE
);
