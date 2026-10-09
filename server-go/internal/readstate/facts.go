package readstate

import (
	"context"
	"database/sql"
)

// Batched viewer-state fact readers over the 0011 tables. They accept the
// caller's executor (a pinned read snapshot or the caller's transaction) so
// an application read model can assemble channel rows and viewer state on
// ONE consistent snapshot. They are read-only; nothing here authorizes by
// itself.

// ViewerReadState is the persisted read-frontier row of one (workspace,
// viewer, channel): the last read seq and the read-state version. The
// per-scope union wire shape is rendered by the presenter from the
// ReadFrontier facts.
type ViewerReadState struct {
	ChannelID        string
	LastReadSeq      int64
	ReadStateVersion int64
}

// ViewerMuteState is the persisted activity-mute row. FromSeq is NULL while
// unmuted; the wire boundary null/number distinction is preserved by the
// Valid flag.
type ViewerMuteState struct {
	ChannelID     string
	ActivityMuted bool
	FromSeq       sql.NullInt64
	PrefsVersion  int64
}

// ViewerDisplayPrefs is the persisted display-prefs row (collapse default).
type ViewerDisplayPrefs struct {
	ChannelID    string
	CollapseLong bool
	PrefsVersion int64
}

// ViewerReadStatesTx loads the viewer's read rows for the given channels on
// the caller's executor. Channels without a row are simply absent.
func (s *Store) ViewerReadStatesTx(ctx context.Context, ex Queryer, workspaceID, userID string, channelIDs []string) (map[string]ViewerReadState, error) {
	out := map[string]ViewerReadState{}
	if len(channelIDs) == 0 {
		return out, nil
	}
	inList, args := inListArgs(workspaceID, userID, channelIDs)
	rows, err := ex.QueryContext(ctx, `SELECT channel_id, last_read_seq, read_state_version
		FROM user_channel_read_states WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r ViewerReadState
		if err := rows.Scan(&r.ChannelID, &r.LastReadSeq, &r.ReadStateVersion); err != nil {
			return nil, err
		}
		out[r.ChannelID] = r
	}
	return out, rows.Err()
}

// ViewerMuteStatesTx loads the viewer's activity-mute rows.
func (s *Store) ViewerMuteStatesTx(ctx context.Context, ex Queryer, workspaceID, userID string, channelIDs []string) (map[string]ViewerMuteState, error) {
	out := map[string]ViewerMuteState{}
	if len(channelIDs) == 0 {
		return out, nil
	}
	inList, args := inListArgs(workspaceID, userID, channelIDs)
	rows, err := ex.QueryContext(ctx, `SELECT channel_id, activity_muted, mute_from_seq, prefs_version
		FROM user_channel_mute_states WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var muted int
		var r ViewerMuteState
		if err := rows.Scan(&r.ChannelID, &muted, &r.FromSeq, &r.PrefsVersion); err != nil {
			return nil, err
		}
		r.ActivityMuted = muted != 0
		out[r.ChannelID] = r
	}
	return out, rows.Err()
}

// ViewerDisplayPrefsTx loads the viewer's display-prefs rows.
func (s *Store) ViewerDisplayPrefsTx(ctx context.Context, ex Queryer, workspaceID, userID string, channelIDs []string) (map[string]ViewerDisplayPrefs, error) {
	out := map[string]ViewerDisplayPrefs{}
	if len(channelIDs) == 0 {
		return out, nil
	}
	inList, args := inListArgs(workspaceID, userID, channelIDs)
	rows, err := ex.QueryContext(ctx, `SELECT channel_id, collapse_long_messages, prefs_version
		FROM user_channel_display_prefs WHERE workspace_id = ? AND user_id = ? AND channel_id IN `+inList, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var collapse int
		var r ViewerDisplayPrefs
		if err := rows.Scan(&r.ChannelID, &collapse, &r.PrefsVersion); err != nil {
			return nil, err
		}
		r.CollapseLong = collapse != 0
		out[r.ChannelID] = r
	}
	return out, rows.Err()
}

// inListArgs builds the "(?,?,...)" IN list and its argument slice for the
// (workspace, user, channels...) batch readers.
func inListArgs(workspaceID, userID string, channelIDs []string) (string, []any) {
	placeholders := ""
	for i, id := range channelIDs {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		_ = id
	}
	args := make([]any, 0, len(channelIDs)+2)
	args = append(args, workspaceID, userID)
	for _, id := range channelIDs {
		args = append(args, id)
	}
	return "(" + placeholders + ")", args
}
