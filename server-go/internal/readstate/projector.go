package readstate

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/auth"
)

// ProjectedEvent is one socket-ready event rendered from CURRENT authorized
// facts for one publication intent. The realtime integration worker owns
// rooms and delivery; this projector owns the exact payload shape and the
// subject's current authorization.
type ProjectedEvent struct {
	// Event is the original socket event name (compat §4.2).
	Event string
	// ServerID is the workspace the event belongs to.
	ServerID string
	// SubjectUserID is the private owner the event targets ("" for shared
	// receipts). The worker sends private events to the user∩workspace room.
	SubjectUserID string
	// Payload is the exact wire body (single payload argument).
	Payload map[string]any
	// SharedScope marks an audience-shared receipt (scope_read): the worker
	// resolves the currently-authorized scope room, never the user room.
	SharedScope bool
}

// ProjectPublication renders the current-authorized payloads for one
// publication intent produced by this package's mutations.
//
// Contract (frozen for the parent's realtime worker):
//   - The subject's full claims are revalidated against CURRENT facts
//     (session family, live membership). A stale or revoked subject yields
//     (nil, nil): the wake is dropped, never delivered on old authority.
//   - Payloads are re-read from current database facts inside one snapshot;
//     no payload is persisted in the publication and none is cached.
//   - read_state:updated        → {serverId, scopeId, maxReadSeq, readStateVersion}
//     (legacy lossy JS numbers; values are ≤2^53 by schema).
//   - unread_summary:changed    → {serverId} (invalidate + re-read wake).
//   - notification_prefs:updated → {serverId, scopeId,
//     prefs:{activityMuted, muteFromSeq}, prefsVersion}.
//   - message_display_prefs:updated → {serverId, scopeId,
//     prefs:{collapseLongMessages}, prefsVersion}.
//   - scope_read:updated is NOT projected for human subjects: the original
//     emitScopeReadUpdated broadcasts only agent peers (readReceiptService.ts
//     builds the exposed-peer list from agents only and drops a human actor
//     before emitting), and M4 has no agent read writers. The branch is kept
//     with its exact future payload so the event stays vocabulary-complete:
//     {scopeId, peerKind, peerId, maxReadSeq} (or {scopeId, summaryChanged:true}
//     above the exposed-peer limit — the worker holds that audience count).
func (s *Store) ProjectPublication(ctx context.Context, subjectClaims auth.AccessTokenClaims, p PublicationIntent) ([]ProjectedEvent, error) {
	if p.WorkspaceID == "" {
		return nil, invalidInput("publication intent carries no workspace")
	}
	var events []ProjectedEvent
	err := s.readSnapshot(ctx, s.db, func(ex Executor) error {
		if err := s.validateHuman(ctx, ex, subjectClaims, s.now()); err != nil {
			if errors.Is(err, ErrTokenInvalid) {
				return nil // stale subject: drop the wake, not an error
			}
			return err
		}
		role, err := membershipRoleTx(ctx, ex, p.WorkspaceID, subjectClaims.Subject)
		if err != nil {
			return err
		}
		if role == "" {
			return nil // membership lost between enqueue and projection
		}
		switch p.EventType {
		case EventReadStateUpdated:
			row, err := readStateForScopeTx(ctx, ex, p.WorkspaceID, subjectClaims.Subject, p.ObjectID)
			if err != nil {
				return err
			}
			if row == nil {
				return nil
			}
			events = append(events, ProjectedEvent{
				Event:         EventReadStateUpdated,
				ServerID:      p.WorkspaceID,
				SubjectUserID: subjectClaims.Subject,
				Payload: map[string]any{
					"serverId":         p.WorkspaceID,
					"scopeId":          p.ObjectID,
					"maxReadSeq":       row.lastReadSeq,
					"readStateVersion": row.version,
				},
			})
		case EventUnreadSummaryChanged:
			events = append(events, ProjectedEvent{
				Event:         EventUnreadSummaryChanged,
				ServerID:      p.WorkspaceID,
				SubjectUserID: subjectClaims.Subject,
				Payload:       map[string]any{"serverId": p.WorkspaceID},
			})
		case EventNotificationPrefs:
			var muted int64
			var boundary sql.NullInt64
			var version int64
			err := ex.QueryRowContext(ctx, `
				SELECT activity_muted, mute_from_seq, prefs_version
				FROM user_channel_mute_states
				WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
				p.WorkspaceID, subjectClaims.Subject, p.ObjectID).Scan(&muted, &boundary, &version)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			var muteFrom any
			if boundary.Valid {
				muteFrom = boundary.Int64
			}
			events = append(events, ProjectedEvent{
				Event:         EventNotificationPrefs,
				ServerID:      p.WorkspaceID,
				SubjectUserID: subjectClaims.Subject,
				Payload: map[string]any{
					"serverId":     p.WorkspaceID,
					"scopeId":      p.ObjectID,
					"prefs":        map[string]any{"activityMuted": muted == 1, "muteFromSeq": muteFrom},
					"prefsVersion": version,
				},
			})
		case EventMessageDisplayPrefs:
			var collapse int64
			var version int64
			err := ex.QueryRowContext(ctx, `
				SELECT collapse_long_messages, prefs_version
				FROM user_channel_display_prefs
				WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
				p.WorkspaceID, subjectClaims.Subject, p.ObjectID).Scan(&collapse, &version)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			events = append(events, ProjectedEvent{
				Event:         EventMessageDisplayPrefs,
				ServerID:      p.WorkspaceID,
				SubjectUserID: subjectClaims.Subject,
				Payload: map[string]any{
					"serverId":     p.WorkspaceID,
					"scopeId":      p.ObjectID,
					"prefs":        map[string]any{"collapseLongMessages": collapse == 1},
					"prefsVersion": version,
				},
			})
		case "scope_read:updated":
			// Human reads never broadcast (see the contract note above): the
			// exposed-peer list is agents-only in the reference, so a human
			// actor is dropped before any emission. M4 writes only human
			// reads, so the honest projection is no event. When agent read
			// writers arrive, project {scopeId, peerKind, peerId, maxReadSeq}
			// with SharedScope=true (or {scopeId, summaryChanged:true} above
			// the exposed-peer limit).
			return nil
		default:
			// Unknown vocabulary is not fabricated into an event.
			return nil
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return events, nil
}
