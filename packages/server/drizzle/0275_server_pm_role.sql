ALTER TABLE "servers" ADD COLUMN "pm_agent_id" uuid;
ALTER TABLE "servers" ADD COLUMN "pm_setup_dismissed_at" timestamptz;
DO $$ BEGIN
  ALTER TABLE "servers" ADD CONSTRAINT "servers_pm_agent_id_agents_id_fk" FOREIGN KEY ("pm_agent_id") REFERENCES "agents"("id") ON DELETE set null;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS "pm_role_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" uuid NOT NULL,
  "from_agent_id" uuid,
  "to_agent_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "pm_role_audit_events" ADD CONSTRAINT "pm_role_audit_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE cascade;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "pm_role_audit_events" ADD CONSTRAINT "pm_role_audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "pm_role_audit_events" ADD CONSTRAINT "pm_role_audit_events_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "agents"("id") ON DELETE set null;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "pm_role_audit_events" ADD CONSTRAINT "pm_role_audit_events_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "agents"("id") ON DELETE set null;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "idx_pm_role_audit_server" ON "pm_role_audit_events" USING btree ("server_id","created_at");
