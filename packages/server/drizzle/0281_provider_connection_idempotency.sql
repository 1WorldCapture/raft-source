ALTER TABLE "provider_connections" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_connections_server_idempotency" ON "provider_connections" USING btree ("server_id","idempotency_key");
