package message

import (
	"context"
	"database/sql"
	"fmt"

	"raft.local/server-go/internal/channel"
)

// LastMessageFacts is the batched last-message fact reader for application
// read models: it loads MAX(created_at) (epoch millis) per channel on the
// caller's executor, so list-exit facts share the caller's pinned snapshot.
// Channels without any message are absent from the result. Read-only; it
// does not authorize anything.
func (s *Store) LastMessageFactsTx(ctx context.Context, ex channel.Executor, workspaceID string, channelIDs []string) (map[string]int64, error) {
	out := map[string]int64{}
	if len(channelIDs) == 0 {
		return out, nil
	}
	placeholders := ""
	args := make([]any, 0, len(channelIDs)+1)
	args = append(args, workspaceID)
	for i, id := range channelIDs {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, id)
	}
	rows, err := ex.QueryContext(ctx, `SELECT m.channel_id, MAX(m.created_at)
		FROM messages m WHERE m.workspace_id = ? AND m.channel_id IN (`+placeholders+`) GROUP BY m.channel_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var channelID string
		var createdAt int64
		if err := rows.Scan(&channelID, &createdAt); err != nil {
			return nil, err
		}
		out[channelID] = createdAt
	}
	return out, rows.Err()
}

// AttachThreadToParentTx is the SINGLE writer of messages.thread_id: it
// projects the ensured thread channel onto its parent message. The
// application use case calls it in the SAME transaction as the channel-owned
// thread ensure and the author follow (the field must never be written from
// the channel domain or ad-hoc application SQL). The write is idempotent,
// exactly like the original ensure's projection.
func (s *Store) AttachThreadToParentTx(ctx context.Context, tx *sql.Tx, parentMessageID, threadChannelID string) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE messages SET thread_id = ? WHERE id = ?`, threadChannelID, parentMessageID); err != nil {
		return fmt.Errorf("attach parent thread: %w", err)
	}
	return nil
}
