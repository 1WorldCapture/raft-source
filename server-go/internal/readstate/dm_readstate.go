package readstate

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// ReadFrontierJSONTx renders the EXACT original #632 InboxScopeReadFrontier
// wire union for one (workspace, user, channel) on the caller's snapshot:
//
//	{"kind":"absent"}
//	{"kind":"corrupt"}                       (never produced from typed rows)
//	{"kind":"present","readStateVersion":<number>,
//	 "maxReadSeq":"<decimal string>",
//	 "latestActivity":{"messageId":"…","seq":"<decimal string>"} | null}
//
// Presence is the STRUCTURAL fact "a cursor row exists" (version 0 and
// maxReadSeq "0" are legal values); latestActivity is a same-source pair
// from the scope's newest message, null when the scope has no message —
// never assembled across sources. The caller has already authorized the
// scope in the same snapshot; this projection adds no authorization of its
// own beyond refusing unknown scopes.
func (s *Store) ReadFrontierJSONTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (json.RawMessage, error) {
	row, err := readStateForScopeTx(ctx, ex, workspaceID, userID, channelID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return json.RawMessage(`{"kind":"absent"}`), nil
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
	payload := map[string]any{
		"kind":             "present",
		"readStateVersion": row.version,
		"maxReadSeq":       formatUint64(uint64(row.lastReadSeq)),
	}
	if err == nil && latestID.Valid && latestSeq.Valid {
		payload["latestActivity"] = map[string]any{
			"messageId": latestID.String,
			"seq":       formatUint64(uint64(latestSeq.Int64)),
		}
	} else {
		payload["latestActivity"] = nil
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("render read frontier: %w", err)
	}
	return json.RawMessage(buf), nil
}

// DMReadStateTx is the DM-scoped variant the parent wires into the M4
// conversation handlers: the caller has already authorized the DM scope on
// the SAME snapshot, and this projection additionally fails closed when the
// channel is not a DM of this workspace or the user is not a participant
// (direct_messages pair; the channel roster row is accepted as the paired
// write the channel worker performs). The returned bytes are the exact
// #632 readFrontier wire — the parent never assembles kind/version/maxReadSeq
// /latestActivity shapes itself.
func (s *Store) DMReadStateTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (json.RawMessage, error) {
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
	return s.ReadFrontierJSONTx(ctx, ex, workspaceID, userID, channelID)
}
