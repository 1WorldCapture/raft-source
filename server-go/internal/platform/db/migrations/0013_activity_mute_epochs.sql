-- M4 durable human Activity suppression intervals. These are notification
-- eligibility facts, not read cursors or channel access grants. Unmuting must
-- not backfill ordinary messages that committed while muted. Message seq,
-- rather than timestamp equality, fixes both interval boundaries.
-- epoch_version is the per-receiver/channel prefs version; version0 records
-- an implicit announcement-mute prefix. The clock is audit data, not a key.
CREATE TABLE user_channel_mute_epochs (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    epoch_version INTEGER NOT NULL CHECK (typeof(epoch_version)='integer' AND epoch_version>=0 AND epoch_version<=9007199254740991),
    mute_from_seq INTEGER NOT NULL CHECK (typeof(mute_from_seq)='integer' AND mute_from_seq>=0 AND mute_from_seq<=9007199254740991),
    suppressed_through_seq INTEGER CHECK (suppressed_through_seq IS NULL OR
        (typeof(suppressed_through_seq)='integer' AND suppressed_through_seq>=mute_from_seq-1 AND suppressed_through_seq<=9007199254740991)),
    muted_at INTEGER NOT NULL,
    unmuted_at INTEGER,
    PRIMARY KEY (workspace_id,user_id,channel_id,epoch_version),
    FOREIGN KEY (channel_id,workspace_id) REFERENCES channels(id,workspace_id) ON DELETE CASCADE,
    CHECK ((suppressed_through_seq IS NULL) = (unmuted_at IS NULL))
);
CREATE INDEX idx_user_channel_mute_epochs_user
    ON user_channel_mute_epochs(workspace_id,user_id,channel_id);
CREATE UNIQUE INDEX idx_user_channel_mute_epochs_open
    ON user_channel_mute_epochs(workspace_id,user_id,channel_id)
    WHERE suppressed_through_seq IS NULL;
