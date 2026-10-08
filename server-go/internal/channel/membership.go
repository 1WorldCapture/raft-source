// Roster membership writes, porting addHuman/addAgent/removeHuman/removeAgent/
// addGuestHumanIfAllowed plus the empty-private-channel cleanup. Every write
// accepts an optional Executor so callers can run inside their transaction;
// real roster transitions also record their channel:members-updated intent on
// that same transaction (publications.go documents the dispatch contract).
package channel

import (
	"context"
	"database/sql"
	"fmt"
)

// AddHuman ports addHuman: server membership is required, guests may never be
// channel admins, system channels are a no-op for non-guests, and the insert
// is idempotent. Returns whether a row was newly created. A REAL insert
// records the channel:members-updated intent on the same transaction (the
// TS add-member emission pair derives from it, see publications.go); an
// idempotent no-op records nothing. Callers that must build roster rows
// without a membership event (CreateChannel's initial members, whose TS
// counterpart only publishes the channel itself) use addHumanRow directly.
func (s *Store) AddHuman(ctx context.Context, channelID, userID string, role string, ex Executor) (bool, error) {
	if tx, ok := ex.(*sql.Tx); ok {
		return s.addHumanWithIntent(ctx, tx, channelID, userID, role)
	}
	// A bare handle is wrapped in one write transaction so the roster row and
	// its intent can never commit apart.
	var added bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		added, err = s.addHumanWithIntent(ctx, tx, channelID, userID, role)
		return err
	})
	return added, err
}

func (s *Store) addHumanWithIntent(ctx context.Context, tx *sql.Tx, channelID, userID, role string) (bool, error) {
	added, err := s.addHumanRow(ctx, tx, channelID, userID, role)
	if err != nil || !added {
		return added, err
	}
	channel, err := s.getChannel(ctx, tx, channelID, false)
	if err != nil {
		return added, err
	}
	if channel == nil {
		return added, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}
	return added, s.enqueueMembersUpdated(ctx, tx, channel.WorkspaceID, channelID, userID)
}

// addHumanRow is the quiet roster write every caller shares: guards plus the
// idempotent insert, no realtime intent.
func (s *Store) addHumanRow(ctx context.Context, ex Executor, channelID, userID string, role string) (bool, error) {
	if role == "" {
		role = ChannelRoleMember
	}
	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return false, err
	}
	if channel == nil {
		return false, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}
	if channel.Type == TypeThread {
		return false, &DomainError{Code: CodeInvalidInput, Message: "Thread membership is managed via follow/unfollow, not channel_humans"}
	}
	serverRole, err := s.humanServerRole(ctx, ex, channel.WorkspaceID, userID)
	if err != nil {
		return false, err
	}
	if serverRole == "" {
		return false, &DomainError{Code: CodeInvalidInput, Message: "Human is not a member of this channel's server"}
	}
	if serverRole == RoleGuest && role == ChannelRoleAdmin {
		return false, &DomainError{Code: CodeForbidden, Message: "Guest cannot be a channel admin"}
	}
	if IsAllSystemChannel(channel) {
		if serverRole == RoleGuest {
			return false, &DomainError{Code: CodeForbidden, Message: "Guest cannot be added to the #all channel"}
		}
		return false, nil
	}
	if IsAnnouncementChannel(channel) {
		if serverRole == RoleGuest {
			return false, &DomainError{Code: CodeForbidden, Message: "Guest cannot be added to the #announcement channel"}
		}
		return false, nil
	}
	res, err := ex.ExecContext(ctx, `
		INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, ?, 1, ?)
		ON CONFLICT DO NOTHING`, channelID, userID, role, s.now().UnixMilli())
	if err != nil {
		return false, fmt.Errorf("insert channel_humans: %w", err)
	}
	inserted, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return inserted > 0, nil
}

// AddAgent ports addAgent: the agent must be live and belong to the channel's
// workspace; system channels are a no-op. Idempotent insert. A REAL insert
// records the channel:members-updated intent on the same transaction; agent
// roster changes carry no subject (the TS emission has no targeted frame).
func (s *Store) AddAgent(ctx context.Context, channelID, agentID string, role string, ex Executor) (bool, error) {
	if tx, ok := ex.(*sql.Tx); ok {
		return s.addAgentWithIntent(ctx, tx, channelID, agentID, role)
	}
	var added bool
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		added, err = s.addAgentWithIntent(ctx, tx, channelID, agentID, role)
		return err
	})
	return added, err
}

func (s *Store) addAgentWithIntent(ctx context.Context, tx *sql.Tx, channelID, agentID, role string) (bool, error) {
	added, err := s.addAgentRow(ctx, tx, channelID, agentID, role)
	if err != nil || !added {
		return added, err
	}
	channel, err := s.getChannel(ctx, tx, channelID, false)
	if err != nil {
		return added, err
	}
	if channel == nil {
		return added, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}
	return added, s.enqueueMembersUpdated(ctx, tx, channel.WorkspaceID, channelID, "")
}

// addAgentRow is the quiet roster write: guards plus the idempotent insert.
func (s *Store) addAgentRow(ctx context.Context, ex Executor, channelID, agentID string, role string) (bool, error) {
	if role == "" {
		role = ChannelRoleMember
	}
	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return false, err
	}
	if channel == nil {
		return false, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}
	if channel.Type == TypeThread {
		return false, &DomainError{Code: CodeInvalidInput, Message: "Thread membership is managed via follow/unfollow, not channel_agents"}
	}
	exists, err := s.AgentExistsInWorkspace(ctx, ex, agentID, channel.WorkspaceID)
	if err != nil {
		return false, err
	}
	if !exists {
		return false, &DomainError{Code: CodeInvalidInput, Message: "Agent is not a member of this channel's server"}
	}
	if IsAllSystemChannel(channel) || IsAnnouncementChannel(channel) {
		return false, nil
	}
	res, err := ex.ExecContext(ctx, `
		INSERT INTO channel_agents (channel_id, agent_id, role, authority_revision, added_at)
		VALUES (?, ?, ?, 1, ?)
		ON CONFLICT DO NOTHING`, channelID, agentID, role, s.now().UnixMilli())
	if err != nil {
		return false, fmt.Errorf("insert channel_agents: %w", err)
	}
	inserted, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return inserted > 0, nil
}

// RemoveHuman ports removeHuman (thread refusal, system-channel refusal, then
// the row delete plus the empty-private-channel cleanup). A REAL row removal
// records the channel:members-updated intent on the same transaction
// (subject empty: the TS removal emission has no targeted frame); deleting a
// member who was never on the roster records nothing.
func (s *Store) RemoveHuman(ctx context.Context, channelID, userID string, ex Executor) error {
	if tx, ok := ex.(*sql.Tx); ok {
		return s.removeHumanWithIntent(ctx, tx, channelID, userID)
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		return s.removeHumanWithIntent(ctx, tx, channelID, userID)
	})
}

func (s *Store) removeHumanWithIntent(ctx context.Context, tx *sql.Tx, channelID, userID string) error {
	removed, workspaceID, err := s.removeHumanRow(ctx, tx, channelID, userID)
	if err != nil {
		return err
	}
	if removed {
		if err := s.enqueueMembersUpdated(ctx, tx, workspaceID, channelID, ""); err != nil {
			return err
		}
	}
	return nil
}

// removeHumanRow is the quiet roster write: guards, the row delete, and the
// empty-private-channel cleanup. It reports whether a row was actually
// deleted and the workspace the channel belongs to ("" when the channel row
// is gone, in which case no intent is possible).
func (s *Store) removeHumanRow(ctx context.Context, ex Executor, channelID, userID string) (bool, string, error) {
	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return false, "", err
	}
	if channel != nil && channel.Type == TypeThread {
		return false, "", &DomainError{Code: CodeInvalidInput, Message: "Thread membership is managed via follow/unfollow, not channel_humans"}
	}
	if channel != nil && IsAllSystemChannel(channel) {
		return false, "", &DomainError{Code: CodeForbidden, Message: "Cannot leave or remove from the #all channel"}
	}
	if channel != nil && IsAnnouncementChannel(channel) {
		return false, "", &DomainError{Code: CodeForbidden, Message: "Cannot remove members from, or leave, the #announcement channel"}
	}
	res, err := ex.ExecContext(ctx, `
		DELETE FROM channel_humans WHERE channel_id = ? AND user_id = ?`, channelID, userID)
	if err != nil {
		return false, "", fmt.Errorf("delete channel_humans: %w", err)
	}
	removed, err := res.RowsAffected()
	if err != nil {
		return false, "", err
	}
	workspaceID := ""
	if channel != nil {
		workspaceID = channel.WorkspaceID
	}
	if err := s.deletePrivateChannelIfEmpty(ctx, channelID, ex); err != nil {
		return false, "", err
	}
	return removed > 0, workspaceID, nil
}

// RemoveAgent ports removeAgent. A REAL row removal records the
// channel:members-updated intent on the same transaction (subject empty).
func (s *Store) RemoveAgent(ctx context.Context, channelID, agentID string, ex Executor) error {
	if tx, ok := ex.(*sql.Tx); ok {
		return s.removeAgentWithIntent(ctx, tx, channelID, agentID)
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		return s.removeAgentWithIntent(ctx, tx, channelID, agentID)
	})
}

func (s *Store) removeAgentWithIntent(ctx context.Context, tx *sql.Tx, channelID, agentID string) error {
	removed, workspaceID, err := s.removeAgentRow(ctx, tx, channelID, agentID)
	if err != nil {
		return err
	}
	if removed {
		if err := s.enqueueMembersUpdated(ctx, tx, workspaceID, channelID, ""); err != nil {
			return err
		}
	}
	return nil
}

// removeAgentRow is the quiet roster write: guards, the row delete, and the
// empty-private-channel cleanup.
func (s *Store) removeAgentRow(ctx context.Context, ex Executor, channelID, agentID string) (bool, string, error) {
	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return false, "", err
	}
	if channel != nil && channel.Type == TypeThread {
		return false, "", &DomainError{Code: CodeInvalidInput, Message: "Thread membership is managed via follow/unfollow, not channel_agents"}
	}
	if channel != nil && IsAllSystemChannel(channel) {
		return false, "", &DomainError{Code: CodeForbidden, Message: "Cannot remove members from the #all channel"}
	}
	if channel != nil && IsAnnouncementChannel(channel) {
		return false, "", &DomainError{Code: CodeForbidden, Message: "Cannot remove members from the #announcement channel"}
	}
	res, err := ex.ExecContext(ctx, `
		DELETE FROM channel_agents WHERE channel_id = ? AND agent_id = ?`, channelID, agentID)
	if err != nil {
		return false, "", fmt.Errorf("delete channel_agents: %w", err)
	}
	removed, err := res.RowsAffected()
	if err != nil {
		return false, "", err
	}
	workspaceID := ""
	if channel != nil {
		workspaceID = channel.WorkspaceID
	}
	if err := s.deletePrivateChannelIfEmpty(ctx, channelID, ex); err != nil {
		return false, "", err
	}
	return removed > 0, workspaceID, nil
}

// deletePrivateChannelIfEmpty ports the TS helper: a private channel with no
// humans AND no agents left is soft-deleted.
func (s *Store) deletePrivateChannelIfEmpty(ctx context.Context, channelID string, ex Executor) error {
	var channelType string
	var deletedAt sql.NullInt64
	err := ex.QueryRowContext(ctx,
		`SELECT type, deleted_at FROM channels WHERE id = ?`, channelID).Scan(&channelType, &deletedAt)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if channelType != TypePrivate || deletedAt.Valid {
		return nil
	}
	var count int
	if err := ex.QueryRowContext(ctx, `
		SELECT (SELECT COUNT(*) FROM channel_humans WHERE channel_id = ?)
		     + (SELECT COUNT(*) FROM channel_agents WHERE channel_id = ?)`,
		channelID, channelID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	_, err = ex.ExecContext(ctx, `
		UPDATE channels SET deleted_at = ?
		WHERE id = ? AND type = 'private' AND deleted_at IS NULL`,
		s.now().UnixMilli(), channelID)
	if err != nil {
		return fmt.Errorf("soft-delete empty private channel: %w", err)
	}
	return nil
}

// Guest join outcomes (TS addGuestHumanIfAllowed).
const (
	GuestJoinJoined        = "joined"
	GuestJoinAlreadyJoined = "already_joined"
	GuestJoinForbidden     = "forbidden"
)

// AddGuestHumanIfAllowed ports addGuestHumanIfAllowed: under the frozen
// disabled guest gate this always answers forbidden, but the full policy
// (member must be guest, joinable channel rules) is kept for the day the gate
// opens. Runs in one transaction with the channel row read inside it.
func (s *Store) AddGuestHumanIfAllowed(ctx context.Context, channelID, userID string) (string, error) {
	var outcome string
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		outcome, err = s.addGuestHumanIfAllowedTx(ctx, tx, channelID, userID)
		return err
	})
	if err != nil {
		return "", err
	}
	return outcome, nil
}

func (s *Store) addGuestHumanIfAllowedTx(ctx context.Context, tx *sql.Tx, channelID, userID string) (string, error) {
	channel, err := s.getChannel(ctx, tx, channelID, false)
	if err != nil {
		return "", err
	}
	if channel == nil {
		return GuestJoinForbidden, nil
	}
	serverRole, err := s.eligibleHumanRole(ctx, tx, channel.WorkspaceID, userID)
	if err != nil {
		return "", err
	}
	if serverRole != RoleGuest {
		return GuestJoinForbidden, nil
	}
	member, err := s.isChannelHuman(ctx, tx, channelID, userID)
	if err != nil {
		return "", err
	}
	if member {
		return GuestJoinAlreadyJoined, nil
	}
	allowed := CanGuestJoinChannel(false, /* gate disabled (frozen policy) */
		serverRole, channel.Type, channel.Name,
		IsAllSystemChannel(channel) && !IsEnabledAllChannel(channel),
		channel.GuestVisible, channel.GuestJoinable, false,
		channel.ArchivedAt != nil, channel.DeletedAt != nil)
	if !allowed {
		return GuestJoinForbidden, nil
	}
	added, err := s.AddHuman(ctx, channelID, userID, "", tx)
	if err != nil {
		return "", err
	}
	if added {
		return GuestJoinJoined, nil
	}
	return GuestJoinAlreadyJoined, nil
}

// InTx runs fn inside one transaction, handing it the Executor so callers
// can compose roster writes with their own reads on one snapshot.
func (s *Store) InTx(ctx context.Context, fn func(tx Executor) error) error {
	return s.withTx(ctx, func(tx *sql.Tx) error { return fn(tx) })
}

// AddHumanTx wraps AddHuman in its own transaction.
func (s *Store) AddHumanTx(ctx context.Context, channelID, userID, role string) (bool, error) {
	var added bool
	err := s.InTx(ctx, func(tx Executor) (err error) {
		added, err = s.AddHuman(ctx, channelID, userID, role, tx)
		return err
	})
	return added, err
}

// AddAgentTx wraps AddAgent in its own transaction.
func (s *Store) AddAgentTx(ctx context.Context, channelID, agentID, role string) (bool, error) {
	var added bool
	err := s.InTx(ctx, func(tx Executor) (err error) {
		added, err = s.AddAgent(ctx, channelID, agentID, role, tx)
		return err
	})
	return added, err
}

// RemoveHumanTx wraps RemoveHuman (including the empty-private cleanup) in
// its own transaction.
func (s *Store) RemoveHumanTx(ctx context.Context, channelID, userID string) error {
	return s.InTx(ctx, func(tx Executor) error { return s.RemoveHuman(ctx, channelID, userID, tx) })
}

// RemoveAgentTx wraps RemoveAgent in its own transaction.
func (s *Store) RemoveAgentTx(ctx context.Context, channelID, agentID string) error {
	return s.InTx(ctx, func(tx Executor) error { return s.RemoveAgent(ctx, channelID, agentID, tx) })
}
