package message

import (
	"context"
	"database/sql"
	"fmt"
)

// ContextResult is the domain message-context read. DTOs share the snapshot
// with the window rows and the summaries.
type ContextResult struct {
	ChannelID       string
	TargetMessageID string
	HasOlder        bool
	HasNewer        bool
	Messages        []*Message
	DTOs            []*MessageDTO
	ThreadSummaries map[string]ThreadSummary
	ChannelArchived bool
}

// GetMessageContext locates targetMessageID inside channelID (the TS
// getMessageContextInChannel scope rule: a channel-scoped id that lives in
// another channel is a 404, not a leak) and returns the surrounding window of
// before/after messages from one snapshot.
func (s *Store) GetMessageContext(ctx context.Context, claims Claims, workspaceID, channelID, messageID string, before, after int) (*ContextResult, error) {
	var result *ContextResult
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		if err := s.validateHuman(ctx, ex, claims.claims); err != nil {
			return err
		}
		if _, err := s.authorizeRead(ctx, ex, workspaceID, channelID, claims.userID); err != nil {
			return err
		}
		var err error
		result, err = s.getMessageContext(ctx, ex, workspaceID, channelID, messageID, before, after, claims.userID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Store) getMessageContext(ctx context.Context, ex dbExecutor, workspaceID, channelID, messageID string, before, after int, viewerID string) (*ContextResult, error) {
	target, err := s.getMessage(ctx, ex, workspaceID, messageID)
	if err != nil || target == nil {
		return nil, err
	}
	if target.ChannelID != channelID {
		return nil, ErrMessageNotFound
	}

	prevRows, err := s.contextWindow(ctx, ex, workspaceID, channelID, target.Seq, before, true)
	if err != nil {
		return nil, err
	}
	nextRows, err := s.contextWindow(ctx, ex, workspaceID, channelID, target.Seq, after, false)
	if err != nil {
		return nil, err
	}
	hasOlder := len(prevRows) > before
	hasNewer := len(nextRows) > after
	prev := prevRows
	if hasOlder {
		prev = prevRows[:before]
	}
	// previous window reads descending; render ascending
	for i, j := 0, len(prev)-1; i < j; i, j = i+1, j-1 {
		prev[i], prev[j] = prev[j], prev[i]
	}
	next := nextRows
	if hasNewer {
		next = nextRows[:after]
	}
	window := append(append([]*Message{}, prev...), target)
	window = append(window, next...)

	summaries, err := s.threadSummariesForParents(ctx, ex, workspaceID, channelID, window, viewerID)
	if err != nil {
		return nil, err
	}

	dtos, err := s.ProjectMessages(ctx, ex, workspaceID, window)
	if err != nil {
		return nil, err
	}

	archived := false
	var archivedAt sql.NullInt64
	if err := ex.QueryRowContext(ctx, `SELECT archived_at FROM channels WHERE id = ? AND workspace_id = ?`,
		channelID, workspaceID).Scan(&archivedAt); err == nil && archivedAt.Valid {
		archived = true
	} else if err != nil && err != sql.ErrNoRows {
		return nil, fmt.Errorf("context archive read: %w", err)
	}
	return &ContextResult{
		ChannelID:       channelID,
		TargetMessageID: target.ID,
		HasOlder:        hasOlder,
		HasNewer:        hasNewer,
		Messages:        window,
		DTOs:            dtos,
		ThreadSummaries: summaries,
		ChannelArchived: archived,
	}, nil
}

// contextWindow reads limit+1 rows on one side of the target seq so the
// hasOlder/hasNewer flags come from a real extra row, not a count guess.
func (s *Store) contextWindow(ctx context.Context, ex dbExecutor, workspaceID, channelID string, seq int64, limit int, older bool) ([]*Message, error) {
	op, order := ">", "m.seq"
	if older {
		op, order = "<", "m.seq DESC"
	}
	rows, err := ex.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages m
		WHERE m.workspace_id = ? AND m.channel_id = ? AND m.seq `+op+` ?
		ORDER BY `+order+` LIMIT ?`, workspaceID, channelID, seq, limit+1)
	if err != nil {
		return nil, fmt.Errorf("context window: %w", err)
	}
	defer rows.Close()
	var out []*Message
	for rows.Next() {
		msg, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, msg)
	}
	return out, rows.Err()
}
