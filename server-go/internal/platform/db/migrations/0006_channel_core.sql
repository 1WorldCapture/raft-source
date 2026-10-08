-- 0006_channel_core: M3A channel slice.
--
-- Owns: the channel-agent roster (TS channel_agents) and the durable
-- channel-membership role-change outbox (TS channel_membership_role_events).
-- Reuses the 0003 channels/channel_humans tables unchanged; adds no message,
-- read-cursor or unread tables (those belong to M4/M5).
--
-- Conventions follow 0001: timestamps are INTEGER unix milliseconds (UTC),
-- booleans are 0/1 integers, UUIDs are TEXT. Ordering contract: runs after
-- 0005_workspace_preferences; channel_agents references agents (0004).

-- 1. Agent channel roster (TS channel_agents). role/authority_revision mirror
-- channel_humans; added_at orders the roster the way TS orders by addedAt.
CREATE TABLE channel_agents (
    channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
    authority_revision INTEGER NOT NULL DEFAULT 1,
    added_at           INTEGER NOT NULL,
    PRIMARY KEY (channel_id, agent_id)
);
CREATE INDEX idx_channel_agents_agent ON channel_agents(agent_id);
CREATE INDEX idx_channel_agents_channel_role ON channel_agents(channel_id, role);

-- 2. Durable audit/outbox fact for channel-local role mutations (TS
-- channel_membership_role_events). The membership update and this row commit
-- together; realtime delivery is a post-commit projection. M3A has no
-- Socket.IO layer, so rows stay 'pending' until the M4 realtime surface
-- drains them — never fabricated as 'sent'.
CREATE TABLE channel_membership_role_events (
    id                  TEXT PRIMARY KEY,
    channel_id          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requester_user_id   TEXT NOT NULL REFERENCES users(id),
    target_type         TEXT NOT NULL CHECK (target_type IN ('user', 'agent')),
    target_id           TEXT NOT NULL,
    previous_role       TEXT NOT NULL CHECK (previous_role IN ('member', 'admin')),
    next_role           TEXT NOT NULL CHECK (next_role IN ('member', 'admin')),
    authority_revision  INTEGER NOT NULL,
    delivery_status     TEXT NOT NULL DEFAULT 'pending'
                        CHECK (delivery_status IN ('pending', 'sent', 'dead_letter')),
    delivery_attempts   INTEGER NOT NULL DEFAULT 0,
    last_delivery_error TEXT,
    created_at          INTEGER NOT NULL,
    delivered_at        INTEGER
);
CREATE INDEX idx_channel_role_events_pending
    ON channel_membership_role_events(delivery_status, created_at);
CREATE INDEX idx_channel_role_events_channel
    ON channel_membership_role_events(channel_id, created_at);
