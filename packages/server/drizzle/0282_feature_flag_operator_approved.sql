ALTER TABLE "feature_flag_rollout_audit_events" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "feature_flag_rollout_audit_events" DROP CONSTRAINT "feature_flag_rollout_audit_authorization_valid";--> statement-breakpoint
ALTER TABLE "feature_flag_rollout_audit_events" ADD CONSTRAINT "feature_flag_rollout_audit_authorization_valid" CHECK ("feature_flag_rollout_audit_events"."authorization" IN ('narrowing', 'guardrail_passed', 'operator_approved'));--> statement-breakpoint
ALTER TABLE "feature_flag_rollout_audit_events" DROP CONSTRAINT "feature_flag_rollout_audit_receipt_matches_authorization";--> statement-breakpoint
ALTER TABLE "feature_flag_rollout_audit_events" ADD CONSTRAINT "feature_flag_rollout_audit_receipt_matches_authorization" CHECK ((
      ("feature_flag_rollout_audit_events"."authorization" = 'narrowing' AND "feature_flag_rollout_audit_events"."receipt_id" IS NULL AND "feature_flag_rollout_audit_events"."approved_by" IS NULL)
      OR ("feature_flag_rollout_audit_events"."authorization" = 'guardrail_passed' AND "feature_flag_rollout_audit_events"."receipt_id" IS NOT NULL AND "feature_flag_rollout_audit_events"."approved_by" IS NULL)
      OR ("feature_flag_rollout_audit_events"."authorization" = 'operator_approved' AND "feature_flag_rollout_audit_events"."receipt_id" IS NULL AND "feature_flag_rollout_audit_events"."approved_by" IS NOT NULL AND length(btrim("feature_flag_rollout_audit_events"."approved_by")) > 0)
    ));
