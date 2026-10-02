CREATE TABLE "external_agent_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_epoch" bigint NOT NULL,
	"run_id" uuid NOT NULL,
	"fence" bigint NOT NULL,
	"request_key" text NOT NULL,
	"receipt_ids" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"activation" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"consumption_mode" text DEFAULT 'legacy' NOT NULL,
	"pause_reason" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"bound_credential_id" uuid,
	"webhook_secret" jsonb,
	"pending_generation" bigint DEFAULT 0 NOT NULL,
	"next_fence" bigint DEFAULT 0 NOT NULL,
	"current_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_inbox_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source" jsonb NOT NULL,
	"source_event_key" text NOT NULL,
	"admitted_generation" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"current_claim_id" uuid,
	"ack_disposition" text,
	"suppress_reason" text,
	"result_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_epoch" bigint NOT NULL,
	"agent_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"wake_id" uuid NOT NULL,
	"fence" bigint NOT NULL,
	"begin_request_key" text NOT NULL,
	"begin_request_digest" text NOT NULL,
	"owner_token_hash" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"max_ends_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"finish_outcome" text
);
--> statement-breakpoint
CREATE TABLE "external_agent_wake_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wake_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"connection_revision" integer NOT NULL,
	"connection_epoch" bigint NOT NULL,
	"dispatch_fence" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"http_status" integer,
	"error_code" text,
	"provider_run_id" text,
	"request_digest" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_agent_wakes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"connection_epoch" bigint NOT NULL,
	"generation_at_creation" bigint NOT NULL,
	"cycle" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"dispatch_owner" text,
	"dispatch_fence" bigint DEFAULT 0 NOT NULL,
	"dispatch_lease_until" timestamp with time zone,
	"startup_deadline" timestamp with time zone,
	"block_reason" text,
	"exhausted_reason" text,
	"recovery_audit_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_agent_claims" ADD CONSTRAINT "external_agent_claims_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_claims" ADD CONSTRAINT "external_agent_claims_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_claims" ADD CONSTRAINT "external_agent_claims_run_id_external_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."external_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_connections" ADD CONSTRAINT "external_agent_connections_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_connections" ADD CONSTRAINT "external_agent_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_inbox_receipts" ADD CONSTRAINT "external_agent_inbox_receipts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_inbox_receipts" ADD CONSTRAINT "external_agent_inbox_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_runs" ADD CONSTRAINT "external_agent_runs_connection_id_external_agent_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."external_agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_runs" ADD CONSTRAINT "external_agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_runs" ADD CONSTRAINT "external_agent_runs_wake_id_external_agent_wakes_id_fk" FOREIGN KEY ("wake_id") REFERENCES "public"."external_agent_wakes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_wake_attempts" ADD CONSTRAINT "external_agent_wake_attempts_wake_id_external_agent_wakes_id_fk" FOREIGN KEY ("wake_id") REFERENCES "public"."external_agent_wakes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_agent_wakes" ADD CONSTRAINT "external_agent_wakes_connection_id_external_agent_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."external_agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_claims_run_request" ON "external_agent_claims" USING btree ("run_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_claims_run_open" ON "external_agent_claims" USING btree ("run_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "idx_external_agent_claims_agent_state" ON "external_agent_claims" USING btree ("agent_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_connections_agent" ON "external_agent_connections" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_external_agent_connections_server" ON "external_agent_connections" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_inbox_receipts_agent_event" ON "external_agent_inbox_receipts" USING btree ("agent_id","source_event_key");--> statement-breakpoint
CREATE INDEX "idx_external_agent_inbox_receipts_pending" ON "external_agent_inbox_receipts" USING btree ("agent_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_runs_begin_key" ON "external_agent_runs" USING btree ("connection_id","connection_epoch","begin_request_key");--> statement-breakpoint
CREATE INDEX "idx_external_agent_runs_connection" ON "external_agent_runs" USING btree ("connection_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_wake_attempts_number" ON "external_agent_wake_attempts" USING btree ("wake_id","attempt_number");--> statement-breakpoint
CREATE INDEX "idx_external_agent_wake_attempts_wake" ON "external_agent_wake_attempts" USING btree ("wake_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_wakes_connection_epoch_cycle" ON "external_agent_wakes" USING btree ("connection_id","connection_epoch","cycle");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_agent_wakes_connection_live" ON "external_agent_wakes" USING btree ("connection_id") WHERE state in ('queued','dispatching','awaiting_agent','active','blocked');--> statement-breakpoint
CREATE INDEX "idx_external_agent_wakes_ready" ON "external_agent_wakes" USING btree ("state","next_attempt_at");