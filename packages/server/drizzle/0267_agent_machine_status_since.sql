-- Agent lifecycle / machine connection "since" timestamps (mgmt-dashboard task #5).
-- Columns are added without a default first so existing rows stay NULL (no
-- table rewrite) and the backfill below can tell them apart.
ALTER TABLE "agents" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "last_status" text;--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
-- Every agents.status transition has emitted agent.status_changed in the same
-- transaction, so the latest such event is when the current status began.
-- One pass over the (event_type, occurred_at) index.
UPDATE "agents" AS a
SET "status_changed_at" = e."occurred_at"
FROM (
  SELECT DISTINCT ON ("subject_id") "subject_id", "occurred_at"
  FROM "notification_events"
  WHERE "event_type" = 'agent.status_changed' AND "subject_id" IS NOT NULL
  ORDER BY "subject_id", "occurred_at" DESC
) AS e
WHERE a."id" = e."subject_id";--> statement-breakpoint
-- Agents that never changed status still hold their creation-time default.
UPDATE "agents" SET "status_changed_at" = "created_at" WHERE "status_changed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "status_changed_at" SET DEFAULT now();
