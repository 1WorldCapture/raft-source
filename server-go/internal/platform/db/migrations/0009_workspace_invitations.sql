-- 0009_workspace_invitations: M3 invitations fix (UI acceptance finding #1).
--
-- Owns the two invitation tables the legacy TS server carries as
-- server_join_links / server_invites (packages/server/src/services/
-- inviteService.ts + db/schema.ts), which the Go router never exposed:
--   1. workspace_join_links — multi-use, revocable join links created by
--      owner/admin (`POST /api/servers/:id/join-links`). The UI contract
--      (packages/web SettingsPanel.tsx JoinLinksSection / InviteHumanDialog)
--      REQUIRES the raw token to be listable again after creation so the
--      admin can re-copy `${origin}/join/<token>`; the raw value therefore
--      persists here by contract, not by oversight. token_digest (sha256
--      hex) is the indexed lookup key so lookups never depend on the raw
--      secret, and the unique index also survives raw-value edits.
--   2. workspace_invites — single-use, email-bound invites sent by mail
--      (`POST /api/servers/:id/invites`). The raw token is handed out
--      exactly once (in the delivered email); ONLY the sha256 digest is
--      stored, mirroring the TS tokenHash design.
--
-- Conventions follow 0001/0003/0008: timestamps are INTEGER unix
-- milliseconds (UTC), UUIDs are TEXT, roles/status are CHECK-constrained
-- TEXT. Append-only: no earlier migration or table is rewritten.

-- 1. workspace_join_links (TS serverJoinLinks).
--    expires_at NULL = never expires; max_uses NULL = unlimited;
--    use_count increments only when a join actually inserted a membership;
--    revoked_at set by DELETE /join-links/:linkId (rows keep audit history).
CREATE TABLE workspace_join_links (
    id                 TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token              TEXT NOT NULL,
    token_digest       TEXT NOT NULL UNIQUE,
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER,
    max_uses           INTEGER,
    use_count          INTEGER NOT NULL DEFAULT 0,
    revoked_at         INTEGER,
    CHECK (max_uses IS NULL OR max_uses >= 1),
    CHECK (use_count >= 0)
);

CREATE INDEX idx_workspace_join_links_workspace ON workspace_join_links(workspace_id);
CREATE INDEX idx_workspace_join_links_active ON workspace_join_links(workspace_id)
    WHERE revoked_at IS NULL;

-- 2. workspace_invites (TS serverInvites).
--    invited_email is stored normalized (trim + lowercase) exactly like the
--    account users.email normalization, so the accept-time email binding
--    compares one canonical form. status: pending -> accepted | expired
--    (revocation deletes the row, matching the TS service).
CREATE TABLE workspace_invites (
    id                 TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    invited_email      TEXT NOT NULL,
    invited_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','guest')),
    token_digest       TEXT NOT NULL UNIQUE,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired')),
    expires_at         INTEGER NOT NULL,
    created_at         INTEGER NOT NULL
);

CREATE INDEX idx_workspace_invites_workspace_status ON workspace_invites(workspace_id, status);
CREATE INDEX idx_workspace_invites_workspace_email ON workspace_invites(workspace_id, invited_email, status);
