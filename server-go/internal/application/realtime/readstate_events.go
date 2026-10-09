package realtime

// Readstate-owned private state events. The readstate slice does not yet
// export a ProjectPublication entry; the projections below are read-only
// re-projections of the agreed 0011 tables (user_channel_read_states /
// user_channel_mute_states / user_channel_display_prefs) mirroring the wire
// semantics of the readstate store's own GET projections.

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/publication"
)

// ReadStateEventPayload is the original normalized read-state DTO.
type ReadStateEventPayload struct {
	ServerID         string
	ScopeID          string
	MaxReadSeq       int64
	ReadStateVersion int64
}

// ReadStateBulkEventPayload is the bulk variant: one event, all scopes.
type ReadStateBulkEventPayload struct {
	ServerID string
	Scopes   []ReadStateEventPayload
}

// UnreadSummaryEventPayload is the exact invalidation hint {serverId}.
type UnreadSummaryEventPayload struct {
	ServerID string
}

// privateScopeAllowedTx applies current content authority to a receiver-owned
// state reference. Owning a retained read/prefs row is not permission to the
// conversation; missing/revoked scopes complete silently, while infrastructure
// failures retain the durable intent for retry.
func (d *Dispatcher) privateScopeAllowedTx(ctx context.Context, ex db.Executor, ref publication.Publication, scopeID string) (bool, error) {
	conversation, err := d.channels.AuthorizeConversationTx(ctx, ex, ref.WorkspaceID, scopeID, ref.SubjectUserID, false)
	if err != nil && channel.AsDomainError(err) != nil {
		return false, nil
	}
	return conversation != nil && err == nil, err
}

func (d *Dispatcher) publishReadState(ctx context.Context, ref publication.Publication) error {
	if ref.SubjectUserID == "" {
		d.completed.Add(1)
		return nil
	}
	serial0 := d.serial()
	var state *ReadStateEventPayload
	err := db.WithReadSnapshot(ctx, d.db, func(ex db.Executor) error {
		if allowed, err := d.privateScopeAllowedTx(ctx, ex, ref, ref.ObjectID); err != nil || !allowed {
			return err
		}
		var maxRead, version int64
		err := ex.QueryRowContext(ctx, `SELECT last_read_seq, read_state_version
			FROM user_channel_read_states
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ref.WorkspaceID, ref.SubjectUserID, ref.ObjectID).Scan(&maxRead, &version)
		if errors.Is(err, sql.ErrNoRows) {
			return nil // state gone: complete without a delivery
		}
		if err != nil {
			return err
		}
		state = &ReadStateEventPayload{ServerID: ref.WorkspaceID, ScopeID: ref.ObjectID, MaxReadSeq: maxRead, ReadStateVersion: version}
		return nil
	})
	if err != nil {
		return err
	}
	if d.serial() != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	if state == nil {
		d.completed.Add(1)
		return nil
	}
	if err := d.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, EventReadState, state); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

func (d *Dispatcher) publishReadStateBulk(ctx context.Context, ref publication.Publication) error {
	if ref.SubjectUserID == "" {
		d.completed.Add(1)
		return nil
	}
	serial0 := d.serial()
	scopes := []ReadStateEventPayload{}
	err := db.WithReadSnapshot(ctx, d.db, func(ex db.Executor) error {
		rows, err := ex.QueryContext(ctx, `SELECT channel_id, last_read_seq, read_state_version
			FROM user_channel_read_states
			WHERE workspace_id = ? AND user_id = ?
			ORDER BY channel_id`, ref.WorkspaceID, ref.SubjectUserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var scope ReadStateEventPayload
			if err := rows.Scan(&scope.ScopeID, &scope.MaxReadSeq, &scope.ReadStateVersion); err != nil {
				return err
			}
			scope.ServerID = ref.WorkspaceID
			scopes = append(scopes, scope)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		visible := scopes[:0]
		for _, scope := range scopes {
			allowed, err := d.privateScopeAllowedTx(ctx, ex, ref, scope.ScopeID)
			if err != nil {
				return err
			}
			if allowed {
				visible = append(visible, scope)
			}
		}
		scopes = visible
		return nil
	})
	if err != nil {
		return err
	}
	if d.serial() != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	if len(scopes) == 0 {
		d.completed.Add(1)
		return nil
	}
	if err := d.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, EventReadStateBulk,
		ReadStateBulkEventPayload{ServerID: ref.WorkspaceID, Scopes: scopes}); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

func (d *Dispatcher) publishUnreadSummary(ctx context.Context, ref publication.Publication) error {
	if ref.SubjectUserID == "" {
		d.completed.Add(1)
		return nil
	}
	if err := d.deliverSetContext(ctx, d.serial(), map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, EventUnreadSummary,
		UnreadSummaryEventPayload{ServerID: ref.WorkspaceID}); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

// NotificationPrefsEventPayload is the frozen prefs envelope (never flattened).
type NotificationPrefsEventPayload struct {
	ServerID string
	ScopeID  string
	Prefs    struct {
		ActivityMuted bool
		MuteFromSeq   *int64
	}
	PrefsVersion int64
}

func (d *Dispatcher) publishNotificationPrefs(ctx context.Context, ref publication.Publication) error {
	if ref.SubjectUserID == "" {
		d.completed.Add(1)
		return nil
	}
	serial0 := d.serial()
	var payload *NotificationPrefsEventPayload
	err := db.WithReadSnapshot(ctx, d.db, func(ex db.Executor) error {
		if allowed, err := d.privateScopeAllowedTx(ctx, ex, ref, ref.ObjectID); err != nil || !allowed {
			return err
		}
		var muted int64
		var boundary sql.NullInt64
		var version int64
		err := ex.QueryRowContext(ctx, `SELECT activity_muted, mute_from_seq, prefs_version
			FROM user_channel_mute_states
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ref.WorkspaceID, ref.SubjectUserID, ref.ObjectID).Scan(&muted, &boundary, &version)
		out := &NotificationPrefsEventPayload{ServerID: ref.WorkspaceID, ScopeID: ref.ObjectID}
		if errors.Is(err, sql.ErrNoRows) {
			// No stored row: the effective state is the honest default —
			// announcement channels carry the legacy default mute.
			var systemKind sql.NullString
			kindErr := ex.QueryRowContext(ctx, `SELECT system_kind FROM channels
				WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
				ref.ObjectID, ref.WorkspaceID).Scan(&systemKind)
			if kindErr != nil && !errors.Is(kindErr, sql.ErrNoRows) {
				return kindErr
			}
			if systemKind.Valid && systemKind.String == "announcement" {
				out.Prefs.ActivityMuted = true
				zero := int64(0)
				out.Prefs.MuteFromSeq = &zero
			}
			payload = out
			return nil
		}
		if err != nil {
			return err
		}
		out.PrefsVersion = version
		if muted == 1 && boundary.Valid {
			out.Prefs.ActivityMuted = true
			v := boundary.Int64
			out.Prefs.MuteFromSeq = &v
		}
		payload = out
		return nil
	})
	if err != nil {
		return err
	}
	if d.serial() != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	if payload == nil {
		d.completed.Add(1)
		return nil
	}
	if err := d.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, EventNotifPrefs, payload); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

// DisplayPrefsEventPayload keeps the display-prefs version domain separate
// from the mute domain, exactly like the wire contract.
type DisplayPrefsEventPayload struct {
	ServerID string
	ScopeID  string
	Prefs    struct {
		CollapseLongMessages bool
	}
	PrefsVersion int64
}

func (d *Dispatcher) publishDisplayPrefs(ctx context.Context, ref publication.Publication) error {
	if ref.SubjectUserID == "" {
		d.completed.Add(1)
		return nil
	}
	serial0 := d.serial()
	payload := &DisplayPrefsEventPayload{ServerID: ref.WorkspaceID, ScopeID: ref.ObjectID}
	payload.Prefs.CollapseLongMessages = true // the honest default
	err := db.WithReadSnapshot(ctx, d.db, func(ex db.Executor) error {
		if allowed, err := d.privateScopeAllowedTx(ctx, ex, ref, ref.ObjectID); err != nil || !allowed {
			payload = nil
			return err
		}
		var collapse int64
		var version int64
		err := ex.QueryRowContext(ctx, `SELECT collapse_long_messages, prefs_version
			FROM user_channel_display_prefs
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ref.WorkspaceID, ref.SubjectUserID, ref.ObjectID).Scan(&collapse, &version)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		payload.Prefs.CollapseLongMessages = collapse == 1
		payload.PrefsVersion = version
		return nil
	})
	if err != nil {
		return err
	}
	if d.serial() != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	if payload == nil {
		d.completed.Add(1)
		return nil
	}
	if err := d.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, EventDisplayPrefs, payload); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}
