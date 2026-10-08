ALTER TABLE "server_members" DROP CONSTRAINT IF EXISTS "server_members_server_push_mode_valid";
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_push_mode_valid" CHECK ("server_push_mode" IN ('all', 'mentions', 'none', 'pm_dm_mentions'));
