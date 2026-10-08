package readstate

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/auth"
)

// sessionClaims wraps the verified access-token claims for this request. The
// transport layer (parent's legacyweb accessClaims) verified the JWT and the
// live gates; store methods revalidate the family/user/membership inside the
// transaction before mutating anything.
type sessionClaims struct {
	auth.AccessTokenClaims
}

func (c sessionClaims) userID() string { return c.Subject }

// ReadStateResult is the legacy ReadStateMutationResult wire triple.
type ReadStateResult struct {
	ChannelID        string
	MaxReadSeq       int64
	ReadStateVersion int64
	Changed          bool
}

// readStateRow is one stored effective frontier row.
type readStateRow struct {
	lastReadSeq int64
	version     int64
}

// readStateForScopeTx loads one cursor row; absent is (zero row, false).
func readStateForScopeTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (*readStateRow, error) {
	var row readStateRow
	err := ex.QueryRowContext(ctx, `
		SELECT last_read_seq, read_state_version
		FROM user_channel_read_states
		WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
		workspaceID, userID, channelID).Scan(&row.lastReadSeq, &row.version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// latestSeqTx is the channel's committed high-water message seq (0 = empty).
func latestSeqTx(ctx context.Context, ex Queryer, workspaceID, channelID string) (int64, error) {
	var seq sql.NullInt64
	err := ex.QueryRowContext(ctx, `
		SELECT MAX(seq) FROM messages WHERE workspace_id = ? AND channel_id = ?`,
		workspaceID, channelID).Scan(&seq)
	if err != nil {
		return 0, err
	}
	if !seq.Valid {
		return 0, nil
	}
	return seq.Int64, nil
}

// latestUnreadEligibleSeqTx ports the unread boundary input: the newest
// message in the channel that was not sent by this human.
func latestUnreadEligibleSeqTx(ctx context.Context, ex Queryer, workspaceID, channelID, userID string) (int64, error) {
	var seq sql.NullInt64
	err := ex.QueryRowContext(ctx, `
		SELECT MAX(seq) FROM messages
		WHERE workspace_id = ? AND channel_id = ?
		  AND NOT (sender_type = 'user' AND sender_id = ?)`,
		workspaceID, channelID, userID).Scan(&seq)
	if err != nil {
		return 0, err
	}
	if !seq.Valid {
		return 0, nil
	}
	return seq.Int64, nil
}

// applyReadAdvanceTx moves the cursor forward to throughSeq (never backwards)
// when it differs from the stored frontier. Returns the effective result.
// The same (version -> value) row is only rewritten on an actual change, so
// equal versions always map to equal values.
func (s *Store) applyReadAdvanceTx(ctx context.Context, ex Executor, workspaceID, userID, channelID string, throughSeq int64) (ReadStateResult, error) {
	existing, err := readStateForScopeTx(ctx, ex, workspaceID, userID, channelID)
	if err != nil {
		return ReadStateResult{}, err
	}
	now := s.now().UnixMilli()
	if existing != nil && existing.lastReadSeq >= throughSeq {
		return ReadStateResult{
			ChannelID:        channelID,
			MaxReadSeq:       existing.lastReadSeq,
			ReadStateVersion: existing.version,
			Changed:          false,
		}, nil
	}
	version := int64(0)
	if existing != nil {
		version = existing.version
	}
	version++
	if _, err := ex.ExecContext(ctx, `
		INSERT INTO user_channel_read_states
			(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (workspace_id, user_id, channel_id) DO UPDATE SET
			last_read_seq = excluded.last_read_seq,
			read_state_version = excluded.read_state_version,
			updated_at = excluded.updated_at`,
		workspaceID, userID, channelID, throughSeq, version, now); err != nil {
		return ReadStateResult{}, err
	}
	result := ReadStateResult{
		ChannelID:        channelID,
		MaxReadSeq:       throughSeq,
		ReadStateVersion: version,
		Changed:          true,
	}
	if err := s.enqueueReadStatePublicationTx(ctx, ex, workspaceID, userID, result); err != nil {
		return ReadStateResult{}, err
	}
	return result, nil
}

// applyUnreadRewindTx rewinds the cursor to throughSeq (never forward) as the
// explicit mark-unread decision, bumping the version so the wire maxReadSeq
// projects the EFFECTIVE state.
func (s *Store) applyUnreadRewindTx(ctx context.Context, ex Executor, workspaceID, userID, channelID string, throughSeq int64) (ReadStateResult, error) {
	existing, err := readStateForScopeTx(ctx, ex, workspaceID, userID, channelID)
	if err != nil {
		return ReadStateResult{}, err
	}
	if existing != nil && existing.lastReadSeq <= throughSeq {
		return ReadStateResult{
			ChannelID:        channelID,
			MaxReadSeq:       existing.lastReadSeq,
			ReadStateVersion: existing.version,
			Changed:          false,
		}, nil
	}
	version := int64(0)
	if existing != nil {
		version = existing.version
	}
	version++
	if _, err := ex.ExecContext(ctx, `
		INSERT INTO user_channel_read_states
			(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (workspace_id, user_id, channel_id) DO UPDATE SET
			last_read_seq = excluded.last_read_seq,
			read_state_version = excluded.read_state_version,
			updated_at = excluded.updated_at`,
		workspaceID, userID, channelID, throughSeq, version, s.now().UnixMilli()); err != nil {
		return ReadStateResult{}, err
	}
	result := ReadStateResult{
		ChannelID:        channelID,
		MaxReadSeq:       throughSeq,
		ReadStateVersion: version,
		Changed:          true,
	}
	if err := s.enqueueReadStatePublicationTx(ctx, ex, workspaceID, userID, result); err != nil {
		return ReadStateResult{}, err
	}
	return result, nil
}

// enqueueReadStatePublicationTx records the per-scope wake plus the workspace
// unread-summary wake for one changed read state.
func (s *Store) enqueueReadStatePublicationTx(ctx context.Context, ex Executor, workspaceID, userID string, result ReadStateResult) error {
	if !result.Changed {
		return nil
	}
	if err := s.enqueue(ctx, ex, PublicationIntent{
		WorkspaceID:   workspaceID,
		ObjectType:    "read_state",
		ObjectID:      result.ChannelID,
		EventType:     EventReadStateUpdated,
		Revision:      result.ReadStateVersion,
		SubjectUserID: userID,
		ScopeID:       result.ChannelID,
	}); err != nil {
		return err
	}
	return s.enqueueUnreadSummaryWakeTx(ctx, ex, workspaceID, userID, result.ReadStateVersion)
}

func (s *Store) enqueueUnreadSummaryWakeTx(ctx context.Context, ex Executor, workspaceID, userID string, revision int64) error {
	return s.enqueue(ctx, ex, PublicationIntent{
		WorkspaceID:   workspaceID,
		ObjectType:    "unread_summary",
		ObjectID:      workspaceID,
		EventType:     EventUnreadSummaryChanged,
		Revision:      s.now().UnixMilli(),
		SubjectUserID: userID,
		ScopeID:       workspaceID,
	})
}

// MarkRead ports POST /channels/{id}/read: advance the caller's effective
// frontier to seq, bounded by what the channel currently contains, so a
// forged huge seq never becomes a future all-read certificate.
func (s *Store) MarkRead(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string, seq int64) (ReadStateResult, error) {
	var result ReadStateResult
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := getConversationTx(ctx, tx, workspaceID, channelID, true)
		if err != nil {
			return err
		}
		if conv == nil {
			return notFound("Channel not found")
		}
		if _, err := s.authorizeConversationTx(ctx, tx, workspaceID, channelID, claims.Subject); err != nil {
			return mapChannelDomainError(err)
		}
		latest, err := latestSeqTx(ctx, tx, workspaceID, channelID)
		if err != nil {
			return err
		}
		effective := seq
		if effective > latest {
			effective = latest
		}
		if effective < 0 {
			effective = 0
		}
		result, err = s.applyReadAdvanceTx(ctx, tx, workspaceID, claims.Subject, channelID, effective)
		return err
	})
	return result, err
}

// MarkReadLatestResult carries the residue-only receipt flag: a former member
// retiring their own residue learns nothing about the channel's live
// frontier, so the HTTP body omits seq entirely.
type MarkReadLatestResult struct {
	State       ReadStateResult
	ResidueOnly bool
}

// MarkReadLatest ports POST /channels/{id}/read-all (human self path). The
// boundary is the channel's committed high-water seq inside this transaction;
// messages committed afterwards can still be unread. A caller who lost access
// but carries prior-relationship residue may still retire their own state and
// receives the residue-only receipt.
func (s *Store) MarkReadLatest(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string) (MarkReadLatestResult, error) {
	var out MarkReadLatestResult
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := getConversationTx(ctx, tx, workspaceID, channelID, true)
		if err != nil {
			return err
		}
		if conv == nil {
			return notFound("Channel not found")
		}
		residueOnly := false
		if conv.DeletedAt != nil {
			// Soft-deleted scope: only the caller's own residue records can
			// authorize the retire; strangers keep the merged 404.
			related, err := s.hasPriorChannelRelationshipTx(ctx, tx, workspaceID, claims.Subject, channelID)
			if err != nil {
				return err
			}
			if !related {
				return notFound("Channel not found")
			}
			residueOnly = true
		} else if _, err := s.authorizeConversationTx(ctx, tx, workspaceID, channelID, claims.Subject); err != nil {
			de := AsError(mapChannelDomainError(err))
			if de == nil || de.Status != httpStatusNotFound() {
				return mapChannelDomainError(err)
			}
			related, relErr := s.hasPriorChannelRelationshipTx(ctx, tx, workspaceID, claims.Subject, channelID)
			if relErr != nil {
				return relErr
			}
			if !related {
				return mapChannelDomainError(err)
			}
			residueOnly = true
		}
		if residueOnly {
			// A2: a caller who lost access keeps the merged-404 privacy —
			// the retire may not read (let alone store) the channel's
			// CURRENT high-water. The cursor stays exactly as it is; the
			// receipt reports the stored values with changed=false.
			existing, err := readStateForScopeTx(ctx, tx, workspaceID, claims.Subject, channelID)
			if err != nil {
				return err
			}
			state := ReadStateResult{ChannelID: channelID}
			if existing != nil {
				state.MaxReadSeq = existing.lastReadSeq
				state.ReadStateVersion = existing.version
			}
			out = MarkReadLatestResult{State: state, ResidueOnly: true}
			return nil
		}
		latest, err := latestSeqTx(ctx, tx, workspaceID, channelID)
		if err != nil {
			return err
		}
		state, err := s.applyReadAdvanceTx(ctx, tx, workspaceID, claims.Subject, channelID, latest)
		if err != nil {
			return err
		}
		out = MarkReadLatestResult{State: state, ResidueOnly: false}
		return nil
	})
	return out, err
}

func httpStatusNotFound() int { return 404 }

// UnreadResult extends the read-state triple with the recomputed unread count.
type UnreadResult struct {
	State       ReadStateResult
	UnreadCount int64
}

// MarkUnread ports POST /channels/{id}/unread: rewind the effective frontier
// to just before the newest message not sent by the caller. With no
// unread-eligible message it is an honest no-op (zeros, changed=false).
func (s *Store) MarkUnread(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string) (UnreadResult, error) {
	var out UnreadResult
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := getConversationTx(ctx, tx, workspaceID, channelID, true)
		if err != nil {
			return err
		}
		if conv == nil || conv.DeletedAt != nil {
			return notFound("Channel not found")
		}
		if _, err := s.authorizeConversationTx(ctx, tx, workspaceID, channelID, claims.Subject); err != nil {
			return mapChannelDomainError(err)
		}
		boundary, err := latestUnreadEligibleSeqTx(ctx, tx, workspaceID, channelID, claims.Subject)
		if err != nil {
			return err
		}
		if boundary <= 0 {
			// No message from anyone else: nothing can be marked unread.
			existing, err := readStateForScopeTx(ctx, tx, workspaceID, claims.Subject, channelID)
			if err != nil {
				return err
			}
			if existing == nil {
				out = UnreadResult{State: ReadStateResult{ChannelID: channelID}}
				return nil
			}
			out = UnreadResult{State: ReadStateResult{
				ChannelID:        channelID,
				MaxReadSeq:       existing.lastReadSeq,
				ReadStateVersion: existing.version,
				Changed:          false,
			}}
			return nil
		}
		state, err := s.applyUnreadRewindTx(ctx, tx, workspaceID, claims.Subject, channelID, boundary-1)
		if err != nil {
			return err
		}
		// A1: the wire unreadCount COUNTS real messages in THIS channel above
		// the rewound frontier up to the boundary — the global AUTOINCREMENT
		// seq is shared across channels, so a seq difference would count
		// other channels' numbers.
		var count int64
		err = tx.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM messages
			WHERE workspace_id = ? AND channel_id = ?
			  AND seq > ? AND seq <= ?
			  AND NOT (sender_type = 'user' AND sender_id = ?)`,
			workspaceID, channelID, state.MaxReadSeq, boundary, claims.Subject).Scan(&count)
		if err != nil {
			return err
		}
		out = UnreadResult{State: state, UnreadCount: count}
		return nil
	})
	return out, err
}

// InboxReadLatestResult ports InboxReadLatestResult.
type InboxReadLatestResult struct {
	MarkedCount int64
	Scopes      []ReadStateResult
}

// MarkInboxReadLatest ports POST /channels/inbox/read-all: advance every
// currently authorized conversation of this workspace to its own committed
// high-water seq, fixed inside this transaction. Scopes whose frontier was
// already current are excluded from both markedCount and scopes.
func (s *Store) MarkInboxReadLatest(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string) (InboxReadLatestResult, error) {
	var out InboxReadLatestResult
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		role, err := membershipRoleTx(ctx, tx, workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		if role == "guest" {
			// Frozen guest gate: honestly empty, never a blanket mark.
			out = InboxReadLatestResult{MarkedCount: 0, Scopes: []ReadStateResult{}}
			return nil
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT c.id,
			       COALESCE((SELECT MAX(m.seq) FROM messages m
			                 WHERE m.workspace_id = ?2 AND m.channel_id = c.id), 0) AS latest_seq
			FROM channels c
			WHERE c.workspace_id = ?2
			  AND c.deleted_at IS NULL
			  AND c.archived_at IS NULL
			  AND c.type IN ('channel', 'private', 'dm')
			  AND NOT (c.name = 'all' AND c.type <> 'channel')
			  AND (
			    c.type = 'channel'
			    OR EXISTS (SELECT 1 FROM channel_humans ch
			               WHERE ch.channel_id = c.id AND ch.user_id = ?1)
			    OR EXISTS (SELECT 1 FROM direct_messages dm
			               WHERE dm.workspace_id = c.workspace_id
			                 AND dm.channel_id = c.id
			                 AND (dm.user_low = ?1 OR dm.user_high = ?1))
			  )
			  AND NOT EXISTS (
			    SELECT 1 FROM user_channel_done_states d
			    WHERE d.workspace_id = c.workspace_id AND d.user_id = ?1
			      AND d.channel_id = c.id AND d.done_at IS NOT NULL
			      AND d.done_through_activity_seq >=
			          COALESCE((SELECT MAX(m2.seq) FROM messages m2
			                    WHERE m2.workspace_id = c.workspace_id
			                    AND m2.channel_id = c.id), 0)
			  )
			UNION ALL
		SELECT t.id,
		       COALESCE((SELECT MAX(r.seq) FROM messages r
		                 WHERE r.workspace_id = ?2 AND r.channel_id = t.id),
		            (SELECT p.seq FROM messages p
		             WHERE p.id = t.parent_message_id AND p.workspace_id = ?2), 0) AS latest_seq
		FROM channels t
		JOIN thread_follows tf
		  ON tf.workspace_id = t.workspace_id
		 AND tf.thread_channel_id = t.id
		 AND tf.user_id = ?1
		 AND tf.unfollowed_at IS NULL
		JOIN messages pm ON pm.id = t.parent_message_id AND pm.workspace_id = t.workspace_id
		JOIN channels pc ON pc.id = pm.channel_id AND pc.workspace_id = t.workspace_id
		  AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
		  AND NOT (pc.name = 'all' AND pc.type <> 'channel')
		WHERE t.workspace_id = ?2 AND t.type = 'thread' AND t.deleted_at IS NULL
		  AND (
		    pc.type = 'channel'
		    OR EXISTS (SELECT 1 FROM channel_humans pch
		               WHERE pch.channel_id = pc.id AND pch.user_id = ?1)
		    OR EXISTS (SELECT 1 FROM direct_messages pdm
		               WHERE pdm.workspace_id = pc.workspace_id AND pdm.channel_id = pc.id
		                 AND (pdm.user_low = ?1 OR pdm.user_high = ?1))
		  )`,
			claims.Subject, workspaceID)
		if err != nil {
			return err
		}
		type scopeTarget struct {
			id     string
			latest int64
		}
		var targets []scopeTarget
		for rows.Next() {
			var t scopeTarget
			if err := rows.Scan(&t.id, &t.latest); err != nil {
				rows.Close()
				return err
			}
			targets = append(targets, t)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		out.Scopes = []ReadStateResult{}
		for _, target := range targets {
			if target.latest <= 0 {
				continue
			}
			state, err := s.applyReadAdvanceTx(ctx, tx, workspaceID, claims.Subject, target.id, target.latest)
			if err != nil {
				return err
			}
			if state.Changed {
				out.Scopes = append(out.Scopes, state)
			}
		}
		out.MarkedCount = int64(len(out.Scopes))
		// Each changed scope already enqueued its own read_state:updated
		// intent (revision = its readStateVersion) inside applyReadAdvanceTx.
		// A workspace-level bulk intent is deliberately NOT enqueued: its
		// scope list is request state, not a durable object reference, and
		// per-scope events reach the same multi-tab state through the
		// original web reducer.
		return nil
	})
	return out, err
}

// MarkReadLatestTx is the same-transaction read-advance hook for the channel
// worker's follow flow: the legacy followThread marks the thread read inside
// the follow transaction, so the parent calls this on the SAME transaction
// right after its follow write (never a nested WithWriteTx). Full claims are
// revalidated here — the hook is not a trust boundary bypass.
func (s *Store) MarkReadLatestTx(ctx context.Context, ex Executor, claims auth.AccessTokenClaims, workspaceID, channelID string) (ReadStateResult, error) {
	if err := s.validateHuman(ctx, ex, claims, s.now()); err != nil {
		return ReadStateResult{}, err
	}
	role, err := membershipRoleTx(ctx, ex, workspaceID, claims.Subject)
	if err != nil {
		return ReadStateResult{}, err
	}
	if role == "" {
		return ReadStateResult{}, forbidden("Not a member of this server")
	}
	conv, err := getConversationTx(ctx, ex, workspaceID, channelID, true)
	if err != nil {
		return ReadStateResult{}, err
	}
	if conv == nil {
		return ReadStateResult{}, notFound("Channel not found")
	}
	if _, err := s.authorizeConversationTx(ctx, ex, workspaceID, channelID, claims.Subject); err != nil {
		return ReadStateResult{}, mapChannelDomainError(err)
	}
	latest, err := latestSeqTx(ctx, ex, workspaceID, channelID)
	if err != nil {
		return ReadStateResult{}, err
	}
	return s.applyReadAdvanceTx(ctx, ex, workspaceID, claims.Subject, channelID, latest)
}

// ReadCursorTx is the read-only frontier hook for channel-owned thread
// projections (the parent's readCursor seam): the stored effective maxReadSeq
// of one (workspace,user,channel), 0 when no cursor row exists.
func (s *Store) ReadCursorTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (int64, error) {
	row, err := readStateForScopeTx(ctx, ex, workspaceID, userID, channelID)
	if err != nil {
		return 0, err
	}
	if row == nil {
		return 0, nil
	}
	return row.lastReadSeq, nil
}
