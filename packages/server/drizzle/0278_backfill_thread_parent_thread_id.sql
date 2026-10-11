-- Upstream 1.21.2 port (their 0292; generic form): thread parents that never
-- received their thread_id stamp — created before getOrCreateThread stamped
-- the parent in the same transaction as the thread. Search relies on "a
-- thread's parent always carries its thread_id". Only NULL stamps on parents
-- of LIVE threads are filled; an existing thread_id is never overwritten and
-- deleted threads are not stamped. Idempotent.
UPDATE messages
SET thread_id = t.id
FROM channels t
WHERE t.type = 'thread'
  AND t.deleted_at IS NULL
  AND t.parent_message_id = messages.id
  AND messages.thread_id IS NULL;
