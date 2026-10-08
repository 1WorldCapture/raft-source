-- M4 authorization generations. These contain no credentials or payloads.
-- Triggers change the durable generation in the SAME transaction as authority.
-- db.WithWriteTx publishes committed generations into the process cache before
-- releasing its short admission fence. Transport close is only a wake action;
-- final queue admission still checks the exact session and generation.
CREATE TABLE authority_clock (
    id INTEGER PRIMARY KEY CHECK (id=1),
    value INTEGER NOT NULL CHECK (typeof(value)='integer' AND value>=0)
);
INSERT INTO authority_clock(id,value) VALUES(1,0);
CREATE TABLE authority_epochs (
    kind TEXT NOT NULL CHECK (kind IN ('user','workspace','family')),
    scope_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (typeof(generation)='integer' AND generation>0),
    PRIMARY KEY(kind,scope_id)
);
CREATE INDEX idx_authority_epochs_generation ON authority_epochs(generation);
-- No FK: a deleted principal/scope needs a retained generation tombstone.

CREATE TRIGGER m4_session_family_revoke AFTER UPDATE OF revoked_at ON session_families
WHEN NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('family',NEW.id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_session_family_delete AFTER DELETE ON session_families
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('family',OLD.id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_user_authority_update AFTER UPDATE OF email_verified,name,password_hash ON users
WHEN NEW.email_verified IS NOT OLD.email_verified OR NEW.name IS NOT OLD.name OR NEW.password_hash IS NOT OLD.password_hash
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('user',NEW.id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_user_authority_delete AFTER DELETE ON users
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('user',OLD.id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;

CREATE TRIGGER m4_membership_insert AFTER INSERT ON workspace_memberships
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',NEW.workspace_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_membership_delete AFTER DELETE ON workspace_memberships
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',OLD.workspace_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_membership_role AFTER UPDATE OF role ON workspace_memberships
WHEN NEW.role IS NOT OLD.role
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',NEW.workspace_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_workspace_authority AFTER UPDATE OF owner_id,deleted_at,kind,hide_humans_from_members,slug ON workspaces
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.kind IS NOT OLD.kind
 OR NEW.hide_humans_from_members IS NOT OLD.hide_humans_from_members OR NEW.slug IS NOT OLD.slug
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',NEW.id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_workspace_delete AFTER DELETE ON workspaces
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',OLD.id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;

CREATE TRIGGER m4_channel_insert AFTER INSERT ON channels
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',NEW.workspace_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_channel_authority AFTER UPDATE OF type,name,system_kind,guest_visible,guest_joinable,parent_message_id,archived_at,deleted_at ON channels
WHEN NEW.type IS NOT OLD.type OR NEW.name IS NOT OLD.name OR NEW.system_kind IS NOT OLD.system_kind
 OR NEW.guest_visible IS NOT OLD.guest_visible OR NEW.guest_joinable IS NOT OLD.guest_joinable
 OR NEW.parent_message_id IS NOT OLD.parent_message_id OR NEW.archived_at IS NOT OLD.archived_at OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',NEW.workspace_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_channel_delete AFTER DELETE ON channels
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('workspace',OLD.workspace_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_channel_human_insert AFTER INSERT ON channel_humans
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    SELECT 'workspace',workspace_id,(SELECT value FROM authority_clock WHERE id=1) FROM channels WHERE id=NEW.channel_id
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_channel_human_delete AFTER DELETE ON channel_humans
WHEN EXISTS(SELECT 1 FROM channels WHERE id=OLD.channel_id)
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    SELECT 'workspace',workspace_id,(SELECT value FROM authority_clock WHERE id=1) FROM channels WHERE id=OLD.channel_id
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_channel_human_role AFTER UPDATE OF role,authority_revision ON channel_humans
WHEN NEW.role IS NOT OLD.role OR NEW.authority_revision IS NOT OLD.authority_revision
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    SELECT 'workspace',workspace_id,(SELECT value FROM authority_clock WHERE id=1) FROM channels WHERE id=NEW.channel_id
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;

-- Follow changes affect interest, not base content access. Invalidating the
-- user's subscription generation prevents old queued follower-only payloads
-- from surviving an unfollow; explicit subsequent history reads still work.
CREATE TRIGGER m4_thread_follow_insert AFTER INSERT ON thread_follows
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('user',NEW.user_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_thread_follow_update AFTER UPDATE OF unfollowed_at ON thread_follows
WHEN NEW.unfollowed_at IS NOT OLD.unfollowed_at
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('user',NEW.user_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
CREATE TRIGGER m4_thread_follow_delete AFTER DELETE ON thread_follows
BEGIN
    UPDATE authority_clock SET value=value+1 WHERE id=1;
    INSERT INTO authority_epochs(kind,scope_id,generation)
    VALUES('user',OLD.user_id,(SELECT value FROM authority_clock WHERE id=1))
    ON CONFLICT(kind,scope_id) DO UPDATE SET generation=excluded.generation;
END;
