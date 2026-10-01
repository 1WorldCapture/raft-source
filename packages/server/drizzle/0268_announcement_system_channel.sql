CREATE TABLE "progress_announcement_state" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"last_nudged_at" timestamp with time zone,
	"idle_since" timestamp with time zone,
	"idle_posts_made" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "system_kind" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "progress_announcements_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "progress_announcement_state" ADD CONSTRAINT "progress_announcement_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progress_announcement_state" ADD CONSTRAINT "progress_announcement_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_progress_announcement_state_server" ON "progress_announcement_state" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channels_server_system_kind" ON "channels" USING btree ("server_id","system_kind") WHERE system_kind is not null and deleted_at is null;--> statement-breakpoint
-- Tag the existing #all (it keeps being identified by name elsewhere; this only
-- gives system channels a common marker).
UPDATE "channels" SET "system_kind" = 'all'
WHERE "name" = 'all' AND "type" IN ('channel', 'private') AND "deleted_at" IS NULL AND "system_kind" IS NULL;--> statement-breakpoint
-- The name is reserved for the system channel: a user channel already called
-- #announcement is soft-deleted (decided by the product owner; none exist today).
UPDATE "channels" SET "deleted_at" = now()
WHERE "name" = 'announcement' AND "type" IN ('channel', 'private', 'joint')
  AND "deleted_at" IS NULL AND "system_kind" IS NULL;--> statement-breakpoint
-- Backfill the channel for every live server. Membership is implicit (derived
-- from server membership, no channel_humans/channel_agents rows), like #all.
INSERT INTO "channels" ("id", "server_id", "name", "description", "type", "system_kind")
SELECT gen_random_uuid(), s."id", 'announcement', 'Agent progress announcements', 'channel', 'announcement'
FROM "servers" s
WHERE s."deleted_at" IS NULL AND s."kind" = 'normal'
  AND NOT EXISTS (
    SELECT 1 FROM "channels" c
    WHERE c."server_id" = s."id" AND c."system_kind" = 'announcement' AND c."deleted_at" IS NULL
  );
