package readstate

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/channel"
)

// Conversation is the minimal channel fact readstate authorizes against. It
// is derived from the frozen shared schema inside the caller's transaction;
// the channel worker's richer Conversation type is not imported to keep the
// module dependency direction one-way (channel must not import readstate,
// readstate only reads agreed channel facts).
type Conversation struct {
	ID              string
	WorkspaceID     string
	Name            string
	Type            string // channel | private | joint | dm | thread
	SystemKind      *string
	ParentMessageID *string
	CreatedAt       int64
	ArchivedAt      *int64
	DeletedAt       *int64
}

// IsThread reports the first-level thread channel type.
func (c *Conversation) IsThread() bool { return c != nil && c.Type == "thread" }

// implicitServerMembership mirrors channel.HasImplicitServerMembership: the
// enabled #all and the announcement channel derive membership from the
// workspace roster.
func (c *Conversation) implicitServerMembership() bool {
	if c == nil || c.SystemKind == nil {
		return false
	}
	if *c.SystemKind == "announcement" {
		return true
	}
	if *c.SystemKind == "all" && c.Type == "channel" {
		return true
	}
	return false
}

// supportsActivityMute ports channelTypeSupportsActivityMute: only
// channel/private/joint expose a user-reachable mute toggle.
func (c *Conversation) supportsActivityMute() bool {
	return c != nil && (c.Type == "channel" || c.Type == "private" || c.Type == "joint")
}

// getConversationTx loads one channel row inside the transaction.
// includeDeleted keeps soft-deleted rows for the residue paths.
func getConversationTx(ctx context.Context, ex Queryer, workspaceID, channelID string, includeDeleted bool) (*Conversation, error) {
	row := ex.QueryRowContext(ctx, `
		SELECT id, workspace_id, COALESCE(name, ''), type, system_kind,
		       parent_message_id, created_at, archived_at, deleted_at
		FROM channels
		WHERE id = ? AND workspace_id = ?`+deletedPredicate(includeDeleted),
		channelID, workspaceID)
	return scanConversation(row)
}

func deletedPredicate(includeDeleted bool) string {
	if includeDeleted {
		return ""
	}
	return ` AND deleted_at IS NULL`
}

func scanConversation(row *sql.Row) (*Conversation, error) {
	var c Conversation
	var systemKind, parentMessageID sql.NullString
	var createdAt, archivedAt, deletedAt sql.NullInt64
	if err := row.Scan(&c.ID, &c.WorkspaceID, &c.Name, &c.Type, &systemKind,
		&parentMessageID, &createdAt, &archivedAt, &deletedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	c.CreatedAt = createdAt.Int64
	if systemKind.Valid {
		v := systemKind.String
		c.SystemKind = &v
	}
	if parentMessageID.Valid {
		v := parentMessageID.String
		c.ParentMessageID = &v
	}
	if archivedAt.Valid {
		v := archivedAt.Int64
		c.ArchivedAt = &v
	}
	if deletedAt.Valid {
		v := deletedAt.Int64
		c.DeletedAt = &v
	}
	return &c, nil
}

// membershipRoleTx is the caller's live workspace role, "" when the
// membership predicate of RequireChannelServer would reject (deleted or
// joint_storage workspaces never count).
func membershipRoleTx(ctx context.Context, ex Queryer, workspaceID, userID string) (string, error) {
	var role string
	err := ex.QueryRowContext(ctx, `
		SELECT m.role
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ?
		  AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
		workspaceID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return role, nil
}

// isDMParticipantTx reports a human's membership in a canonical human-human
// or human-Agent DM. It never treats workspace membership as DM admission.
func isDMParticipantTx(ctx context.Context, ex Queryer, workspaceID, channelID, userID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1 FROM `+humanDMParticipantsSQL+`
		WHERE workspace_id = ? AND channel_id = ?
		  AND (user_low = ? OR user_high = ?)`,
		workspaceID, channelID, userID, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// isChannelHumanTx reports an explicit channel_humans roster row.
func isChannelHumanTx(ctx context.Context, ex Queryer, channelID, userID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1 FROM channel_humans WHERE channel_id = ? AND user_id = ?`,
		channelID, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// authorizeConversationTx delegates the base content policy to the channel
// worker's locked AuthorizeConversationTx (shared failure vocabulary: missing
// membership -> 403 Not a member of this server; invisible/cross-space or a
// broken thread parent chain -> 404 Channel not found; hidden #all and the
// frozen guest gate fail closed). includeDeleted paths do not use this helper:
// the residue adjudication loads the row itself so a soft-deleted channel is
// distinguishable from a missing one without leaking existence.
func (s *Store) authorizeConversationTx(ctx context.Context, ex Executor, workspaceID, channelID, userID string) (*channel.Conversation, error) {
	if s.channels == nil {
		return nil, errors.New("readstate store is missing the channel store")
	}
	return s.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, userID, false)
}

// mapChannelDomainError maps a channel.DomainError onto this package's wire
// error shape (same statuses and sentences the transport would produce).
func mapChannelDomainError(err error) error {
	de := channel.AsDomainError(err)
	if de == nil {
		return err
	}
	switch de.Code {
	case channel.CodeNotFound:
		return notFound(de.Message)
	case channel.CodeForbidden:
		if de.Message == channel.NotServerMemberMessage {
			return forbidden(de.Message)
		}
		return forbidden(de.Message)
	case channel.CodeConflict:
		return &Error{Status: 409, Code: "CONFLICT", Message: de.Message}
	default:
		return &Error{Status: 400, Code: de.Code, Message: de.Message}
	}
}

// hasDeletedDMThreadParentTx ports hasDeletedDmThreadParent: a live thread
// whose parent message sits in a soft-deleted DM channel.
func hasDeletedDMThreadParentTx(ctx context.Context, ex Queryer, workspaceID, threadChannelID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1
		FROM channels t
		JOIN messages pm ON pm.id = t.parent_message_id
		JOIN channels pc ON pc.id = pm.channel_id
		WHERE t.id = ? AND t.workspace_id = ? AND t.type = 'thread'
		  AND t.deleted_at IS NULL
		  AND pc.workspace_id = ? AND pc.type = 'dm' AND pc.deleted_at IS NOT NULL`,
		threadChannelID, workspaceID, workspaceID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// hasUserThreadResidueTx ports hasUserThreadResidue reduced to the receiver
// rows this Go schema owns: a read state, a done state, a mention
// suppression or a thread_follows row keyed by the caller. Every witness is
// written by the server and keyed by the caller's own id, so a stranger
// cannot manufacture one.
func (s *Store) hasUserThreadResidueTx(ctx context.Context, ex Queryer, workspaceID, userID, threadChannelID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1 WHERE
			EXISTS (SELECT 1 FROM user_channel_read_states
			        WHERE workspace_id = ? AND user_id = ? AND channel_id = ?)
		 OR EXISTS (SELECT 1 FROM user_channel_done_states
		            WHERE workspace_id = ? AND user_id = ? AND channel_id = ?)
		 OR EXISTS (SELECT 1 FROM user_mention_suppressions
		            WHERE workspace_id = ? AND user_id = ? AND channel_id = ?)
		 OR EXISTS (SELECT 1 FROM thread_follows
		            WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ?)`,
		workspaceID, userID, threadChannelID,
		workspaceID, userID, threadChannelID,
		workspaceID, userID, threadChannelID,
		workspaceID, userID, threadChannelID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// hasPriorChannelRelationshipTx ports hasPriorChannelRelationship: the
// caller's own readstate/done/suppression/follow rows prove a past
// relationship; current membership is deliberately NOT consulted.
func (s *Store) hasPriorChannelRelationshipTx(ctx context.Context, ex Queryer, workspaceID, userID, channelID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1 WHERE
			EXISTS (SELECT 1 FROM user_channel_read_states
			        WHERE workspace_id = ? AND user_id = ? AND channel_id = ?)
		 OR EXISTS (SELECT 1 FROM user_channel_done_states
		            WHERE workspace_id = ? AND user_id = ? AND channel_id = ?)
		 OR EXISTS (SELECT 1 FROM user_mention_suppressions
		            WHERE workspace_id = ? AND user_id = ? AND channel_id = ?)
		 OR EXISTS (SELECT 1 FROM channel_humans
		            WHERE channel_id = ? AND user_id = ?)
		 OR EXISTS (SELECT 1 FROM `+humanDMParticipantsSQL+`
		            WHERE workspace_id = ? AND channel_id = ?
		              AND (user_low = ? OR user_high = ?))`,
		workspaceID, userID, channelID,
		workspaceID, userID, channelID,
		workspaceID, userID, channelID,
		channelID, userID,
		workspaceID, channelID, userID, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// validateMutationPrincipal revalidates the human session and the live
// workspace membership inside the transaction. A session failure is
// ErrTokenInvalid (401); a missing membership is a 403 domain error with the
// legacy sentence.
func (s *Store) validateMutationPrincipal(ctx context.Context, ex Queryer, claims sessionClaims, workspaceID string) error {
	if err := s.validateHuman(ctx, ex, claims.AccessTokenClaims, s.now()); err != nil {
		if errors.Is(err, ErrTokenInvalid) {
			return err
		}
		return err
	}
	role, err := membershipRoleTx(ctx, ex, workspaceID, claims.userID())
	if err != nil {
		return err
	}
	if role == "" {
		return forbidden("Not a member of this server")
	}
	return nil
}
