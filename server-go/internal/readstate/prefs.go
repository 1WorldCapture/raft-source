package readstate

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/auth"
)

// MuteState is the notification-settings wire triple (plus the changed flag
// the publication projector consumes).
type MuteState struct {
	ActivityMuted         bool
	MuteFromSeq           *int64
	PrefsVersion          int64
	ActivityMuteSupported bool
	Changed               bool
}

// DisplayPrefs is the message-display-settings wire pair.
type DisplayPrefs struct {
	CollapseLongMessages bool
	PrefsVersion         int64
	Changed              bool
}

// NotificationSettings ports GET /channels/{id}/notification-settings. The
// effective activityMuted requires a captured muteFromSeq; a row without the
// boundary is not an active mute. Announcement channels carry the legacy
// default mute when the caller has no explicit row.
func (s *Store) NotificationSettings(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string) (MuteState, error) {
	var out MuteState
	err := s.readSnapshot(ctx, s.db, func(ex Executor) error {
		if err := s.validateHuman(ctx, ex, claims, s.now()); err != nil {
			return err
		}
		role, err := membershipRoleTx(ctx, ex, workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		if role == "" {
			return forbidden("Not a member of this server")
		}
		conv, err := s.resolvePrefsTargetTx(ctx, ex, workspaceID, channelID, claims.Subject,
			"Thread notification settings are managed via follow/unfollow")
		if err != nil {
			return err
		}
		out, err = s.muteStateTx(ctx, ex, workspaceID, claims.Subject, conv)
		return err
	})
	return out, err
}

// SetNotificationSettings ports PATCH /channels/{id}/notification-settings.
// mute captures the boundary at latest+1 (a mention or a thread always
// pierces); unmute clears it. A same-value PATCH is an honest no-op that
// leaves prefsVersion untouched.
func (s *Store) SetNotificationSettings(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string, muted bool) (MuteState, error) {
	var out MuteState
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := s.resolvePrefsTargetTx(ctx, tx, workspaceID, channelID, claims.Subject,
			"Thread notification settings are managed via follow/unfollow")
		if err != nil {
			return err
		}
		current, err := s.muteStateTx(ctx, tx, workspaceID, claims.Subject, conv)
		if err != nil {
			return err
		}
		if current.ActivityMuted == muted {
			current.Changed = false
			out = current
			return nil
		}
		now := s.now().UnixMilli()
		// Freeze any IMPLICIT announcement suppression that was active before
		// this first explicit transition: the default mute suppressed every
		// ordinary announcement message so far ([0, latest]); without a
		// closed epoch here, the first explicit unmute would backfill them.
		if conv.SystemKind != nil && *conv.SystemKind == "announcement" {
			var hasRow, hasEpoch int
			if err := tx.QueryRowContext(ctx, `
				SELECT (SELECT COUNT(*) FROM user_channel_mute_states ms
				        WHERE ms.workspace_id = ? AND ms.user_id = ? AND ms.channel_id = ?)
				       + (SELECT COUNT(*) FROM user_channel_mute_epochs ee
				          WHERE ee.workspace_id = ? AND ee.user_id = ? AND ee.channel_id = ?)`,
				workspaceID, claims.Subject, conv.ID,
				workspaceID, claims.Subject, conv.ID).Scan(&hasRow); err != nil {
				return err
			}
			_ = hasEpoch
			if hasRow == 0 {
				latest, err := latestSeqTx(ctx, tx, workspaceID, conv.ID)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO user_channel_mute_epochs
						(workspace_id, user_id, channel_id, epoch_version, mute_from_seq,
						 suppressed_through_seq, muted_at, unmuted_at)
					VALUES (?, ?, ?, 0, 0, ?, 0, ?)`,
					workspaceID, claims.Subject, conv.ID, latest, now); err != nil {
					return err
				}
			}
		}
		var boundary sql.NullInt64
		if muted {
			latest, err := latestSeqTx(ctx, tx, workspaceID, conv.ID)
			if err != nil {
				return err
			}
			boundary = sql.NullInt64{Int64: latest + 1, Valid: true}
			// Open a durable mute epoch: every ordinary message that commits
			// while this epoch is open is suppressed as an Activity fact —
			// permanently. A later unmute closes the epoch at the then-current
			// max seq instead of recomputing from the flag, so suppressed
			// facts are never backfilled (frozen inboxPolicyModel semantics).
			// epoch_version = this transaction's next prefs_version
			// (monotonic; 0 is reserved for the implicit announcement
			// prefix), so same-millisecond toggles can never collide.
			nextVersion, err := nextPrefsVersionTx(ctx, tx, workspaceID, claims.Subject, conv.ID)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO user_channel_mute_epochs
					(workspace_id, user_id, channel_id, epoch_version, mute_from_seq,
					 suppressed_through_seq, muted_at, unmuted_at)
				VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
				workspaceID, claims.Subject, conv.ID, nextVersion, latest+1, now); err != nil {
				return err
			}
		} else {
			// Close every open epoch at the current high-water: the frozen
			// suppressed range is exactly the messages that committed while
			// muted. Messages after this boundary are eligible again.
			latest, err := latestSeqTx(ctx, tx, workspaceID, conv.ID)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE user_channel_mute_epochs
				SET suppressed_through_seq = MAX(?, mute_from_seq - 1), unmuted_at = ?
				WHERE workspace_id = ? AND user_id = ? AND channel_id = ?
				  AND suppressed_through_seq IS NULL`,
				latest, now, workspaceID, claims.Subject, conv.ID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_channel_mute_states
				(workspace_id, user_id, channel_id, activity_muted, mute_from_seq,
				 prefs_version, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 1, ?, ?)
			ON CONFLICT (workspace_id, user_id, channel_id) DO UPDATE SET
				activity_muted = excluded.activity_muted,
				mute_from_seq = excluded.mute_from_seq,
				prefs_version = user_channel_mute_states.prefs_version + 1,
				updated_at = excluded.updated_at`,
			workspaceID, claims.Subject, conv.ID, boolToInt(muted), boundary, now, now); err != nil {
			return err
		}
		var state MuteState
		state.ActivityMuted = muted
		state.ActivityMuteSupported = conv.supportsActivityMute()
		state.Changed = true
		if muted {
			state.MuteFromSeq = &boundary.Int64
		}
		var version sql.NullInt64
		if err := tx.QueryRowContext(ctx, `
			SELECT prefs_version FROM user_channel_mute_states
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			workspaceID, claims.Subject, conv.ID).Scan(&version); err != nil {
			return err
		}
		state.PrefsVersion = version.Int64
		out = state
		return s.enqueue(ctx, tx, PublicationIntent{
			WorkspaceID:   workspaceID,
			ObjectType:    "notification_prefs",
			ObjectID:      conv.ID,
			EventType:     EventNotificationPrefs,
			Revision:      state.PrefsVersion,
			SubjectUserID: claims.Subject,
			ScopeID:       conv.ID,
		})
	})
	return out, err
}

// DisplaySettings ports GET /channels/{id}/message-display-settings. The
// default is collapseLongMessages=true with prefsVersion 0.
func (s *Store) DisplaySettings(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string) (DisplayPrefs, error) {
	var out DisplayPrefs
	err := s.readSnapshot(ctx, s.db, func(ex Executor) error {
		if err := s.validateHuman(ctx, ex, claims, s.now()); err != nil {
			return err
		}
		role, err := membershipRoleTx(ctx, ex, workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		if role == "" {
			return forbidden("Not a member of this server")
		}
		conv, err := s.resolvePrefsTargetTx(ctx, ex, workspaceID, channelID, claims.Subject,
			"Thread message display settings are managed by the parent channel")
		if err != nil {
			return err
		}
		var collapse int64
		var version int64
		err = ex.QueryRowContext(ctx, `
			SELECT collapse_long_messages, prefs_version
			FROM user_channel_display_prefs
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			workspaceID, claims.Subject, conv.ID).Scan(&collapse, &version)
		if errors.Is(err, sql.ErrNoRows) {
			out = DisplayPrefs{CollapseLongMessages: true}
			return nil
		}
		if err != nil {
			return err
		}
		out = DisplayPrefs{CollapseLongMessages: collapse == 1, PrefsVersion: version}
		return nil
	})
	return out, err
}

// SetDisplaySettings ports PATCH /channels/{id}/message-display-settings
// with its own independent version domain.
func (s *Store) SetDisplaySettings(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string, collapse bool) (DisplayPrefs, error) {
	var out DisplayPrefs
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := s.resolvePrefsTargetTx(ctx, tx, workspaceID, channelID, claims.Subject,
			"Thread message display settings are managed by the parent channel")
		if err != nil {
			return err
		}
		var currentCollapse int64
		var currentVersion int64
		err = tx.QueryRowContext(ctx, `
			SELECT collapse_long_messages, prefs_version
			FROM user_channel_display_prefs
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			workspaceID, claims.Subject, conv.ID).Scan(&currentCollapse, &currentVersion)
		if errors.Is(err, sql.ErrNoRows) {
			currentCollapse, currentVersion = 1, 0
			err = nil
		}
		if err != nil {
			return err
		}
		if (currentCollapse == 1) == collapse {
			out = DisplayPrefs{CollapseLongMessages: collapse, PrefsVersion: currentVersion, Changed: false}
			return nil
		}
		now := s.now().UnixMilli()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_channel_display_prefs
				(workspace_id, user_id, channel_id, collapse_long_messages,
				 prefs_version, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, ?, ?)
			ON CONFLICT (workspace_id, user_id, channel_id) DO UPDATE SET
				collapse_long_messages = excluded.collapse_long_messages,
				prefs_version = user_channel_display_prefs.prefs_version + 1,
				updated_at = excluded.updated_at`,
			workspaceID, claims.Subject, conv.ID, boolToInt(collapse), now, now); err != nil {
			return err
		}
		var version int64
		if err := tx.QueryRowContext(ctx, `
			SELECT prefs_version FROM user_channel_display_prefs
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			workspaceID, claims.Subject, conv.ID).Scan(&version); err != nil {
			return err
		}
		out = DisplayPrefs{CollapseLongMessages: collapse, PrefsVersion: version, Changed: true}
		return s.enqueue(ctx, tx, PublicationIntent{
			WorkspaceID:   workspaceID,
			ObjectType:    "message_display_prefs",
			ObjectID:      conv.ID,
			EventType:     EventMessageDisplayPrefs,
			Revision:      version,
			SubjectUserID: claims.Subject,
			ScopeID:       conv.ID,
		})
	})
	return out, err
}

// resolvePrefsTargetTx ports resolveActivityMuteTarget /
// resolveMessageDisplayPrefsTarget: workspace-scoped load, thread scope is a
// 400 with the exact sentence, invisible channels are the merged 404.
func (s *Store) resolvePrefsTargetTx(ctx context.Context, ex Queryer, workspaceID, channelID, userID string, threadRefusal string) (*Conversation, error) {
	conv, err := getConversationTx(ctx, ex, workspaceID, channelID, false)
	if err != nil {
		return nil, err
	}
	if conv == nil {
		return nil, notFound("Channel not found")
	}
	if conv.Type == "thread" {
		return nil, invalidInput(threadRefusal)
	}
	if _, err := s.authorizeConversationTx(ctx, toExecutor(ex), workspaceID, channelID, userID); err != nil {
		return nil, mapChannelDomainError(err)
	}
	return conv, nil
}

// toExecutor adapts a Queryer-only caller into the channel walker's Executor
// requirement for read-only authorization (no writes are performed).
func toExecutor(ex Queryer) Executor {
	if e, ok := ex.(Executor); ok {
		return e
	}
	return queryerAdapter{ex}
}

type queryerAdapter struct{ q Queryer }

func (a queryerAdapter) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return nil, errors.New("readstate: executor adapter is read-only")
}
func (a queryerAdapter) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return a.q.QueryContext(ctx, query, args...)
}
func (a queryerAdapter) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return a.q.QueryRowContext(ctx, query, args...)
}

// announcementDefaultMute is the legacy ANNOUNCEMENT_DEFAULT_MUTE:
// {activityMuted: true, muteFromSeq: 0, prefsVersion: 0}. The boundary 0 (not
// null) suppresses every ordinary announcement message as an Activity fact;
// a personal mention still pierces.
func announcementDefaultMute() MuteState {
	zero := int64(0)
	return MuteState{ActivityMuted: true, MuteFromSeq: &zero, PrefsVersion: 0}
}

// muteStateTx reads the effective mute triple for one caller and channel.
func (s *Store) muteStateTx(ctx context.Context, ex Queryer, workspaceID, userID string, conv *Conversation) (MuteState, error) {
	var muted int64
	var boundary sql.NullInt64
	var version int64
	err := ex.QueryRowContext(ctx, `
		SELECT activity_muted, mute_from_seq, prefs_version
		FROM user_channel_mute_states
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		workspaceID, userID, conv.ID).Scan(&muted, &boundary, &version)
	var state MuteState
	state.ActivityMuteSupported = conv.supportsActivityMute()
	if errors.Is(err, sql.ErrNoRows) {
		if conv.SystemKind != nil && *conv.SystemKind == "announcement" {
			state = announcementDefaultMute()
		}
		state.ActivityMuteSupported = conv.supportsActivityMute()
		return state, nil
	}
	if err != nil {
		return state, err
	}
	state.PrefsVersion = version
	if muted == 1 && boundary.Valid {
		state.ActivityMuted = true
		v := boundary.Int64
		state.MuteFromSeq = &v
	} else {
		state.ActivityMuted = false
	}
	return state, nil
}

func boolToInt(v bool) int64 {
	if v {
		return 1
	}
	return 0
}

// nextPrefsVersionTx computes the prefs_version this transaction is about to
// write (stored+1, or 1 on the first row): the stable epoch_version key.
func nextPrefsVersionTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (int64, error) {
	var current sql.NullInt64
	err := ex.QueryRowContext(ctx, `
		SELECT prefs_version FROM user_channel_mute_states
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		workspaceID, userID, channelID).Scan(&current)
	if errors.Is(err, sql.ErrNoRows) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	return current.Int64 + 1, nil
}
