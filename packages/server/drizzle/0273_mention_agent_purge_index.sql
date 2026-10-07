-- Task #9: deleteAgent purges mention_delivery_occurrences by agent_id inside
-- its transaction; the existing indexes lead with message_id / machine_id and
-- cannot serve an agent-only lookup, so every per-agent purge would
-- full-scan this table (lock-time risk PM flagged). Agent-leading index.
CREATE INDEX IF NOT EXISTS "idx_mention_delivery_occurrences_agent" ON "mention_delivery_occurrences" USING btree ("agent_id");
