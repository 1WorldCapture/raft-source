ALTER TABLE "mention_delivery_occurrences" ADD COLUMN "delivery_retry_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "mention_delivery_occurrences" ADD COLUMN "delivery_retry_next_allowed_at" timestamp with time zone;
