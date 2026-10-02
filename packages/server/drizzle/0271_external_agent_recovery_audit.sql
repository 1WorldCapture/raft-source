ALTER TABLE "product_events" DROP CONSTRAINT "product_events_subject_type_whitelist";--> statement-breakpoint
ALTER TABLE "product_events" DROP CONSTRAINT "product_events_event_type_whitelist";--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_subject_type_whitelist" CHECK ("product_events"."subject_type" IN ('action_card', 'onboarding_wizard', 'server', 'external_agent_connection', 'external_agent_receipt'));--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_event_type_whitelist" CHECK ("product_events"."event_type" IN (
      'action_card.open',
      'action_card.dismiss',
      'action_card.execute_attempt',
      'action_card.execute_success',
      'action_card.execute_fail',
      'action_card.expired',
      'onboarding_wizard.step_shown',
      'onboarding_wizard.primary_clicked',
      'onboarding_wizard.skip_clicked',
      'onboarding_wizard.dismissed',
      'onboarding_wizard.completed',
      'onboarding_wizard.error',
      'agent.second_created',
      'external_agent.cutover',
      'external_agent.pause',
      'external_agent.unbind',
      'external_agent.rollback',
      'external_agent.resume',
      'external_agent.redrive',
      'external_agent.durable_handoff'
    ));