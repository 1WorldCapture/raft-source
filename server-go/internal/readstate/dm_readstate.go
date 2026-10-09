package readstate

import (
	"context"
	"database/sql"
	"errors"
)

// ReadFrontierTx loads
// one (workspace, viewer, channel) frontier and its same-source
// latest-activity pair on the caller's snapshot. Absent is expressed as
// Present=false, not as a sentinel error.
func (s *Store) ReadFrontierTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (*ReadFrontier, error) {
	row, err := readStateForScopeTx(ctx, ex, workspaceID, userID, channelID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return readFrontierOf(nil, "", nil), nil
	}
	var latestID sql.NullString
	var latestSeq sql.NullInt64
	err = ex.QueryRowContext(ctx, `
		SELECT id, seq FROM messages
		WHERE workspace_id = ? AND channel_id = ?
		ORDER BY seq DESC LIMIT 1`,
		workspaceID, channelID).Scan(&latestID, &latestSeq)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	latest := (*int64)(nil)
	if latestID.Valid && latestSeq.Valid {
		v := latestSeq.Int64
		latest = &v
	}
	id := ""
	if latestID.Valid {
		id = latestID.String
	}
	return readFrontierOf(row, id, latest), nil
}

// DMReadFrontierTx is the DM-scoped variant: the caller has already
// authorized the DM scope on the SAME
// snapshot, and this projection additionally fails closed when the scope is
// not a DM or the viewer is not a participant (member readers follow the
// documented roster exception).
func (s *Store) DMReadFrontierTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (*ReadFrontier, error) {
	conv, err := getConversationTx(ctx, ex, workspaceID, channelID, false)
	if err != nil {
		return nil, err
	}
	if conv == nil || conv.Type != "dm" {
		return nil, notFound("Chat not found")
	}
	participant, err := isDMParticipantTx(ctx, ex, workspaceID, channelID, userID)
	if err != nil {
		return nil, err
	}
	if !participant {
		if member, mErr := isChannelHumanTx(ctx, ex, channelID, userID); mErr != nil {
			return nil, mErr
		} else if !member {
			return nil, notFound("Chat not found")
		}
	}
	return s.ReadFrontierTx(ctx, ex, workspaceID, userID, channelID)
}
