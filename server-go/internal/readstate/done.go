package readstate

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/auth"
)

// DoneInput is the parsed request body of both Done routes. The transport
// layer keeps the JSON tri-state: ThroughPresent reports whether the
// throughActivitySeq key existed at all (null counts as present and fails the
// strict guard), Through carries the raw string when the value was one.
// FrontierSpace is already adjudicated by the transport matrix (412/400)
// before the store call; an omitted value resolves to the canonical current
// snapshot inside the transaction.
type DoneInput struct {
	ThroughPresent bool
	Through        *string
}

// DoneResult is the write receipt. Residue receipts (deleted scope retire)
// add the legacy receipt fields on the wire.
type DoneResult struct {
	// Legacy deleted-target receipt (empty for ordinary writes).
	LegacyNoop                bool
	TerminalReason            string
	RetiredThroughActivitySeq int64
	ReadStateVersion          int64
	Changed                   bool
}

// suppressionTarget is the resolved Done target: the storage channel that
// owns the messages plus its current authoritative latest activity seq.
type suppressionTarget struct {
	workspaceID string
	channelID   string
	kind        string // channel | dm | thread
	latest      *int64 // nil = no messages exist
}

// resolveChannelTargetTx ports resolveChannelSuppressionTarget for a
// non-thread channel (plain channel, private, joint or human DM).
func resolveChannelTargetTx(ctx context.Context, ex Queryer, workspaceID, channelID string) (*suppressionTarget, error) {
	var kind string
	var latest sql.NullInt64
	err := ex.QueryRowContext(ctx, `
		SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END,
		       (SELECT MAX(m.seq) FROM messages m
		        WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.id)
		FROM channels c
		WHERE c.id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL`,
		channelID, workspaceID).Scan(&kind, &latest)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	target := &suppressionTarget{workspaceID: workspaceID, channelID: channelID, kind: kind}
	if latest.Valid {
		v := latest.Int64
		target.latest = &v
	}
	return target, nil
}

// resolveThreadTargetTx ports resolveThreadSuppressionTarget: latest reply
// seq, falling back to the parent message seq for zero-reply threads.
func resolveThreadTargetTx(ctx context.Context, ex Queryer, workspaceID, threadChannelID string) (*suppressionTarget, error) {
	var latest sql.NullInt64
	err := ex.QueryRowContext(ctx, `
		SELECT (SELECT MAX(r.seq) FROM messages r
		        WHERE r.workspace_id = t.workspace_id AND r.channel_id = t.id)
		       -- zero-reply fallback: the parent message seq
		FROM channels t
		WHERE t.id = ? AND t.workspace_id = ? AND t.type = 'thread'
		  AND t.deleted_at IS NULL`,
		threadChannelID, workspaceID).Scan(&latest)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	target := &suppressionTarget{
		workspaceID: workspaceID,
		channelID:   threadChannelID,
		kind:        "thread",
	}
	if latest.Valid {
		v := latest.Int64
		target.latest = &v
		return target, nil
	}
	// Zero replies: resolve the parent message seq from the thread channel.
	var parentSeq sql.NullInt64
	err = ex.QueryRowContext(ctx, `
		SELECT p.seq
		FROM channels t
		JOIN messages p ON p.id = t.parent_message_id
		WHERE t.id = ? AND t.workspace_id = ? AND t.type = 'thread'
		  AND t.deleted_at IS NULL`,
		threadChannelID, workspaceID).Scan(&parentSeq)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return target, nil
		}
		return nil, err
	}
	if parentSeq.Valid {
		v := parentSeq.Int64
		target.latest = &v
	}
	return target, nil
}

// validateDoneFrontierTx ports validateDoneFrontier: REQUIRED (400) for a
// missing/invalid strict value, BEYOND_LATEST (409) when the client claims
// content the target does not contain, ABOVE_INT4_AUTHORITY (409) above the
// legacy ceiling. A nil input resolves to the canonical current snapshot.
func validateDoneFrontier(target *suppressionTarget, present bool, through *string) (int64, *Error) {
	if !present {
		if target.latest == nil {
			// Canonical snapshot of an empty target cannot produce a positive
			// frontier; the legacy guard treats this as a required-frontier 400.
			return 0, doneFrontierRequired(target.channelID)
		}
		return *target.latest, nil
	}
	if through == nil {
		// Present but null: the strict path treats it as an invalid value.
		return 0, doneFrontierRequired(target.channelID)
	}
	raw := *through
	frontier, ok := positiveCanonicalDecimal(raw)
	if !ok {
		return 0, doneFrontierRequired(target.channelID)
	}
	bounded, fits := int64FromUint64(frontier)
	if !fits || bounded > maxSafeWireSeq {
		// Above the message-seq domain this storage can ever contain; treated
		// as beyond-latest rather than an overflow.
		return 0, doneFrontierBeyondLatest(target.channelID, raw, target.latest)
	}
	if target.latest == nil || bounded > *target.latest {
		return 0, doneFrontierBeyondLatest(target.channelID, raw, target.latest)
	}
	if bounded > int4AuthorityMax {
		return 0, doneFrontierAboveInt4Authority(target.channelID, raw)
	}
	return bounded, nil
}

// maxSafeWireSeq is the 0010 message seq ceiling (2^53-1): Done frontiers are
// message seqs, so anything above it can never be storage content.
const maxSafeWireSeq = 9007199254740991

// writeDoneStateTx persists the Done transition: monotonic done_through (max
// of the stored and new frontier), done_at, revision bump, and the paired
// mention-suppression boundary. It never touches thread_follows.
func (s *Store) writeDoneStateTx(ctx context.Context, ex Executor, userID string, target *suppressionTarget, frontier int64) error {
	now := s.now().UnixMilli()
	if _, err := ex.ExecContext(ctx, `
		INSERT INTO user_channel_done_states
			(workspace_id, user_id, channel_id, done_through_activity_seq,
			 done_at, active_override, revision, updated_at)
		VALUES (?, ?, ?, ?, ?, 0, 1, ?)
		ON CONFLICT (workspace_id, user_id, channel_id) DO UPDATE SET
			done_through_activity_seq =
				MAX(user_channel_done_states.done_through_activity_seq, excluded.done_through_activity_seq),
			done_at = excluded.done_at,
			active_override = 0,
			revision = user_channel_done_states.revision + 1,
			updated_at = excluded.updated_at`,
		target.workspaceID, userID, target.channelID, frontier, now, now); err != nil {
		return err
	}
	if _, err := ex.ExecContext(ctx, `
		INSERT INTO user_mention_suppressions
			(workspace_id, user_id, target_kind, channel_id, done_through_seq, done_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (workspace_id, user_id, target_kind, channel_id) DO UPDATE SET
			done_through_seq = MAX(user_mention_suppressions.done_through_seq, excluded.done_through_seq),
			done_at = excluded.done_at,
			updated_at = excluded.updated_at`,
		target.workspaceID, userID, target.kind, target.channelID, frontier, now, now); err != nil {
		return err
	}
	return nil
}

// DoneChannel ports POST /channels/inbox/done for plain channels and human
// DMs. Thread ids are refused as "Chat not found" (threads use DoneThread).
func (s *Store) DoneChannel(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string, input DoneInput) (DoneResult, error) {
	var result DoneResult
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := getConversationTx(ctx, tx, workspaceID, channelID, false)
		if err != nil {
			return err
		}
		if conv == nil || conv.Type == "thread" {
			return notFound("Chat not found")
		}
		if _, err := s.authorizeConversationTx(ctx, tx, workspaceID, channelID, claims.Subject); err != nil {
			return mapChannelDomainError(err)
		}
		target, err := resolveChannelTargetTx(ctx, tx, workspaceID, channelID)
		if err != nil {
			return err
		}
		if target == nil {
			return notFound("Chat not found")
		}
		frontier, derr := validateDoneFrontier(target, input.ThroughPresent, input.Through)
		if derr != nil {
			return derr
		}
		if err := s.writeDoneStateTx(ctx, tx, claims.Subject, target, frontier); err != nil {
			return err
		}
		// Done advances the read cursor to the confirmed frontier (legacy
		// composite behavior) and wakes the user's other devices.
		state, err := s.applyReadAdvanceTx(ctx, tx, workspaceID, claims.Subject, channelID, frontier)
		if err != nil {
			return err
		}
		result = DoneResult{
			TerminalReason:            "",
			RetiredThroughActivitySeq: 0,
			ReadStateVersion:          state.ReadStateVersion,
			Changed:                   state.Changed,
		}
		return nil
	})
	return result, err
}

// UndoneChannel ports POST /channels/inbox/undone: restore the caller's
// active state only. Other users' Done/read rows are untouched; the mention
// suppression boundary is cleared with the Done row.
func (s *Store) UndoneChannel(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, channelID string) error {
	return s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := getConversationTx(ctx, tx, workspaceID, channelID, false)
		if err != nil {
			return err
		}
		if conv == nil || conv.Type == "thread" {
			return notFound("Chat not found")
		}
		if _, err := s.authorizeConversationTx(ctx, tx, workspaceID, channelID, claims.Subject); err != nil {
			return mapChannelDomainError(err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE user_channel_done_states
			SET done_at = NULL, active_override = 1,
			    revision = revision + 1, updated_at = ?
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			s.now().UnixMilli(), workspaceID, claims.Subject, channelID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM user_mention_suppressions
			WHERE workspace_id = ? AND user_id = ?
			  AND target_kind IN ('channel', 'dm') AND channel_id = ?`,
			workspaceID, claims.Subject, channelID); err != nil {
			return err
		}
		return s.enqueueUnreadSummaryWakeTx(ctx, tx, workspaceID, claims.Subject, s.now().UnixMilli())
	})
}

// DoneThread ports POST /channels/threads/done including the deleted-scope
// residue adjudication:
//   - non-thread scope: 400 "Not a thread" for callers who can see the
//     channel, merged 404 for everyone else;
//   - deleted thread / live thread below a deleted DM parent: only the
//     caller's own residue records admit the retire (strangers keep 404);
//   - live thread: base content authorization then the shared frontier guard.
func (s *Store) DoneThread(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, threadChannelID string, input DoneInput) (DoneResult, error) {
	var result DoneResult
	err := s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		active, err := getConversationTx(ctx, tx, workspaceID, threadChannelID, false)
		if err != nil {
			return err
		}
		conv := active
		if conv == nil {
			conv, err = getConversationTx(ctx, tx, workspaceID, threadChannelID, true)
			if err != nil {
				return err
			}
		}
		if conv == nil {
			return notFound("Thread not found")
		}
		if conv.Type != "thread" {
			accessible, err := s.canAccessFallbackTx(ctx, tx, workspaceID, threadChannelID, claims.Subject)
			if err != nil {
				return err
			}
			if accessible {
				return &Error{Status: 400, Code: CodeNotAThread, Message: "Not a thread"}
			}
			return notFound("Thread not found")
		}
		// Deleted thread: retire only from receiver-owned residue evidence.
		if active == nil && conv.DeletedAt != nil {
			receipt, err := s.retireDeletedThreadResidueTx(ctx, tx, claims, workspaceID, threadChannelID, input)
			if err != nil {
				return err
			}
			result = receipt
			return nil
		}
		// Live thread below a deleted DM parent: same receiver-owned evidence.
		deletedParent, err := hasDeletedDMThreadParentTx(ctx, tx, workspaceID, threadChannelID)
		if err != nil {
			return err
		}
		if deletedParent {
			residue, err := s.hasUserThreadResidueTx(ctx, tx, workspaceID, claims.Subject, threadChannelID)
			if err != nil {
				return err
			}
			if !residue {
				return notFound("Thread not found")
			}
			receipt, err := s.retireDeletedThreadResidueTx(ctx, tx, claims, workspaceID, threadChannelID, input)
			if err != nil {
				return err
			}
			result = receipt
			return nil
		}
		if _, err := s.authorizeConversationTx(ctx, tx, workspaceID, threadChannelID, claims.Subject); err != nil {
			return mapChannelDomainError(err)
		}
		target, err := resolveThreadTargetTx(ctx, tx, workspaceID, threadChannelID)
		if err != nil {
			return err
		}
		if target == nil {
			return notFound("Thread not found")
		}
		frontier, derr := validateDoneFrontier(target, input.ThroughPresent, input.Through)
		if derr != nil {
			return derr
		}
		if err := s.writeDoneStateTx(ctx, tx, claims.Subject, target, frontier); err != nil {
			return err
		}
		state, err := s.applyReadAdvanceTx(ctx, tx, workspaceID, claims.Subject, threadChannelID, frontier)
		if err != nil {
			return err
		}
		result = DoneResult{ReadStateVersion: state.ReadStateVersion, Changed: state.Changed}
		return nil
	})
	return result, err
}

// canAccessFallbackTx answers base content authorization without importing
// the channel conversation walker for a possibly-deleted row (the locked
// walker refuses deleted rows, which is exactly what the merged-404 rule
// needs here: deleted + unauthorized look identical).
func (s *Store) canAccessFallbackTx(ctx context.Context, ex Queryer, workspaceID, channelID, userID string) (bool, error) {
	role, err := membershipRoleTx(ctx, ex, workspaceID, userID)
	if err != nil {
		return false, err
	}
	if role == "" {
		return false, nil
	}
	conv, err := getConversationTx(ctx, ex, workspaceID, channelID, true)
	if err != nil || conv == nil {
		return false, err
	}
	switch conv.Type {
	case "channel":
		return true, nil
	case "private":
		return isChannelHumanTx(ctx, ex, channelID, userID)
	case "dm":
		dm, err := isDMParticipantTx(ctx, ex, workspaceID, channelID, userID)
		if err != nil || dm {
			return dm, err
		}
		return isChannelHumanTx(ctx, ex, channelID, userID)
	case "thread":
		if conv.ParentMessageID == nil {
			return false, nil
		}
		var parentChannelID string
		err := ex.QueryRowContext(ctx, `SELECT channel_id FROM messages WHERE id = ?`,
			*conv.ParentMessageID).Scan(&parentChannelID)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		parent, err := getConversationTx(ctx, ex, workspaceID, parentChannelID, true)
		if err != nil || parent == nil {
			return false, err
		}
		if parent.DeletedAt != nil {
			return false, nil
		}
		switch parent.Type {
		case "channel":
			return true, nil
		case "private":
			return isChannelHumanTx(ctx, ex, parent.ID, userID)
		case "dm":
			return isDMParticipantTx(ctx, ex, workspaceID, parent.ID, userID)
		default:
			return false, nil
		}
	default:
		return false, nil
	}
}

// retireDeletedThreadResidueTx ports retireDeletedThreadDoneResidue: advance
// the caller's own read evidence boundary on the retired scope, never
// recreating the source or writing a synthetic Done suppression. A malformed
// strict frontier still fails with the required-frontier 400.
func (s *Store) retireDeletedThreadResidueTx(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, threadChannelID string, input DoneInput) (DoneResult, error) {
	residue, err := s.hasUserThreadResidueTx(ctx, tx, workspaceID, claims.Subject, threadChannelID)
	if err != nil {
		return DoneResult{}, err
	}
	if !residue {
		return DoneResult{}, notFound("Thread not found")
	}
	if input.ThroughPresent {
		if input.Through == nil {
			return DoneResult{}, doneFrontierRequired(threadChannelID)
		}
		if _, ok := positiveCanonicalDecimal(*input.Through); !ok {
			return DoneResult{}, doneFrontierRequired(threadChannelID)
		}
	}
	latest, err := latestSeqTx(ctx, tx, workspaceID, threadChannelID)
	if err != nil {
		return DoneResult{}, err
	}
	state, err := s.applyReadAdvanceTx(ctx, tx, workspaceID, claims.Subject, threadChannelID, latest)
	if err != nil {
		return DoneResult{}, err
	}
	return DoneResult{
		LegacyNoop:                true,
		TerminalReason:            "legacy_done_target_unavailable",
		RetiredThroughActivitySeq: state.MaxReadSeq,
		ReadStateVersion:          state.ReadStateVersion,
		Changed:                   state.Changed,
	}, nil
}

// UndoneThread ports POST /channels/threads/undone: restore the caller's
// thread activity state. An explicitly unfollowed thread stays unfollowed
// (its mention-suppression boundary survives), exactly like the legacy rule.
func (s *Store) UndoneThread(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, threadChannelID string) error {
	return s.writeTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateMutationPrincipal(ctx, tx, sessionClaims{claims}, workspaceID); err != nil {
			return err
		}
		conv, err := getConversationTx(ctx, tx, workspaceID, threadChannelID, false)
		if err != nil {
			return err
		}
		if conv == nil || conv.Type != "thread" {
			return notFound("Thread not found")
		}
		if _, err := s.authorizeConversationTx(ctx, tx, workspaceID, threadChannelID, claims.Subject); err != nil {
			return mapChannelDomainError(err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE user_channel_done_states
			SET done_at = NULL, active_override = 1,
			    revision = revision + 1, updated_at = ?
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			s.now().UnixMilli(), workspaceID, claims.Subject, threadChannelID); err != nil {
			return err
		}
		// Clear the thread mention boundary only while the caller still
		// actively follows (an explicit unfollow keeps its durable boundary).
		var unfollowed sql.NullInt64
		err = tx.QueryRowContext(ctx, `
			SELECT unfollowed_at FROM thread_follows
			WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ?`,
			workspaceID, claims.Subject, threadChannelID).Scan(&unfollowed)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil && !unfollowed.Valid {
			if _, err := tx.ExecContext(ctx, `
				DELETE FROM user_mention_suppressions
				WHERE workspace_id = ? AND user_id = ?
				  AND target_kind = 'thread' AND channel_id = ?`,
				workspaceID, claims.Subject, threadChannelID); err != nil {
				return err
			}
		}
		return s.enqueueUnreadSummaryWakeTx(ctx, tx, workspaceID, claims.Subject, s.now().UnixMilli())
	})
}
