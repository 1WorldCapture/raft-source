-- 0005_workspace_preferences: per-member onboarding preferences and sidebar
-- preferences for the M2 settings worker. Setup status lives in
-- workspace_member_setup (0004); the two facts must not be mixed in one table.
-- Conventions follow 0001: INTEGER unix milliseconds (UTC), 0/1 booleans,
-- TEXT columns holding JSON documents for array/object preferences.
-- The parent relationship is the membership row (workspace_id, user_id); rows
-- are created by workspace creation (and backfilled below for memberships that
-- already exist when this migration runs).

CREATE TABLE workspace_member_preferences (
    workspace_id                    TEXT NOT NULL,
    user_id                         TEXT NOT NULL,

    -- Onboarding preferences (GET/PATCH /api/servers/:id/onboarding-settings).
    -- onboardingReminderOptOut is a response alias of setup_modal_reminder_opt_out,
    -- not a second stored fact.
    setup_modal_reminder_opt_out    INTEGER NOT NULL DEFAULT 0,
    dismissed_add_computer_step_at  INTEGER,
    dismissed_create_agent_step_at  INTEGER,
    dismissed_invite_step_at        INTEGER,
    dismissed_community_step_at     INTEGER,
    dismissed_notification_step_at  INTEGER,
    onboarding_wizard_current_step  TEXT CHECK (
        onboarding_wizard_current_step IS NULL
        OR onboarding_wizard_current_step IN (
            'add-computer', 'detect-runtime', 'create-agent', 'referral-source',
            'invite-teammates', 'join-community', 'enable-notifications', 'complete'
        )
    ),

    -- Briefing delivery facts. Read by the aggregated settings response; only
    -- later agent-delivery modules write them (M2 has no delivery writer).
    onboarding_dm_sent_at           INTEGER,
    onboarding_dm_sent_by_agent_id  TEXT,

    -- Sidebar preferences (GET /api/servers/:id/sidebar-order). The full PATCH
    -- sidebar contract is deferred; these columns are read-and-sanitize only.
    sidebar_channel_order           TEXT CHECK (sidebar_channel_order IS NULL OR json_valid(sidebar_channel_order)),
    sidebar_agent_order             TEXT CHECK (sidebar_agent_order IS NULL OR json_valid(sidebar_agent_order)),
    sidebar_dm_order                TEXT CHECK (sidebar_dm_order IS NULL OR json_valid(sidebar_dm_order)),
    sidebar_channel_sort_mode       TEXT NOT NULL DEFAULT 'manual' CHECK (sidebar_channel_sort_mode IN ('manual','recent','az')),
    sidebar_joint_channel_sort_mode TEXT NOT NULL DEFAULT 'manual' CHECK (sidebar_joint_channel_sort_mode IN ('manual','recent','az')),
    sidebar_dm_sort_mode            TEXT NOT NULL DEFAULT 'manual' CHECK (sidebar_dm_sort_mode IN ('manual','recent','az')),
    sidebar_pinned_sort_mode        TEXT NOT NULL DEFAULT 'manual' CHECK (sidebar_pinned_sort_mode IN ('manual','recent','az')),
    pinned_refs                     TEXT CHECK (pinned_refs IS NULL OR json_valid(pinned_refs)),
    pinned_channel_ids              TEXT CHECK (pinned_channel_ids IS NULL OR json_valid(pinned_channel_ids)),
    pinned_agent_ids                TEXT CHECK (pinned_agent_ids IS NULL OR json_valid(pinned_agent_ids)),
    pinned_order                    TEXT CHECK (pinned_order IS NULL OR json_valid(pinned_order)),
    hidden_dm_ids                   TEXT CHECK (hidden_dm_ids IS NULL OR json_valid(hidden_dm_ids)),
    channel_panel_tab_order         TEXT CHECK (channel_panel_tab_order IS NULL OR json_valid(channel_panel_tab_order)),
    agent_panel_tab_order           TEXT CHECK (agent_panel_tab_order IS NULL OR json_valid(agent_panel_tab_order)),
    sidebar_custom_sections         TEXT CHECK (sidebar_custom_sections IS NULL OR json_valid(sidebar_custom_sections)),
    sidebar_section_order           TEXT CHECK (sidebar_section_order IS NULL OR json_valid(sidebar_section_order)),
    sidebar_section_placements      TEXT CHECK (sidebar_section_placements IS NULL OR json_valid(sidebar_section_placements)),
    sidebar_sections_version        INTEGER NOT NULL DEFAULT 0,
    pinned_version                  INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_member_prefs_user ON workspace_member_preferences(user_id);

-- Every existing membership gets a defaults row; no preference is invented and
-- no setup status is touched here. Creation-time rows are inserted inside the
-- CreateWorkspace transaction after migrations have run, so this backfill only
-- covers memberships that predate this migration.
INSERT INTO workspace_member_preferences (workspace_id, user_id)
SELECT m.workspace_id, m.user_id FROM workspace_memberships m;
