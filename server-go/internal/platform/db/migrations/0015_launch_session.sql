-- 0015_launch_session: per-launch confirmed session binding.
-- Additive only. Does not rewrite 0001–0014, does not INSERT, and does not
-- UPDATE any existing row. confirmed_session_id stays NULL on every launch
-- that already exists: the resume pointer on agents.session_id is NOT copied
-- here. The agent package writes this column only inside the authenticated
-- current-launch agent:session transaction, and only for that launch.
-- Dispatch identity fails closed until that report commits.
ALTER TABLE agent_launches ADD COLUMN confirmed_session_id TEXT;
