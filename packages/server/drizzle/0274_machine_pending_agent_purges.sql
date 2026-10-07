-- Task #4: durable pending agent:purge commands (deleted agent -> machine that
-- still holds its local directories). New empty table; guarded and idempotent.
CREATE TABLE IF NOT EXISTS "machine_pending_agent_purges" (
	"machine_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_outcome" text,
	CONSTRAINT "machine_pending_agent_purges_machine_id_agent_id_pk" PRIMARY KEY("machine_id","agent_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_pending_agent_purges" ADD CONSTRAINT "machine_pending_agent_purges_machine_id_daemons_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."daemons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "machine_pending_agent_purges" ADD CONSTRAINT "machine_pending_agent_purges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
