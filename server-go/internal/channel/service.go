// Channel write use cases: create/update/archive/unarchive/delete, self
// join/leave, and the channel-local role mutation with its durable outbox
// row. Every mutation runs inside one IMMEDIATE transaction (SQLite
// serializes writers, replacing the TS advisory/row locks). Handlers may
// pre-check for the stable HTTP sentence; the transaction re-reads
// membership, role, capability, and channel binding before it writes. Every
// real channel-state or roster transition also records its realtime intent
// inside that SAME transaction (publications.go); deletion deliberately
// records none, mirroring the frozen TS server.
package channel

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	platformdb "raft.local/server-go/internal/platform/db"
)

// CreateInput carries the create payload after route validation.
type CreateInput struct {
	WorkspaceID     string
	Name            string // already trimmed by the route
	Description     *string
	Type            string // channel | private
	CreatorUserID   string
	InitialUserIDs  []string // route-validated, deduped
	InitialAgentIDs []string
}

// CreateChannel ports channelService.createChannel for non-joint channels.
func (s *Store) CreateChannel(ctx context.Context, in CreateInput) (*Channel, error) {
	var created *Channel
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		role, err := s.eligibleHumanRole(ctx, tx, in.WorkspaceID, in.CreatorUserID)
		if err != nil {
			return err
		}
		if role == "" || !HasServerCapability(role, CapCreateChannels) {
			return &DomainError{Code: CodeForbidden, Message: "You do not have permission to create channels"}
		}
		channel, err := s.createChannelTx(ctx, tx, in.WorkspaceID, in.Name, in.Description, in.Type)
		if err != nil {
			return err
		}
		// Creator row (admin) — the one add-member bootstrap. Initial roster
		// rows are quiet: the TS create path publishes the channel itself and
		// emits no per-member members-updated frames.
		if _, err := s.addHumanRow(ctx, tx, channel.ID, in.CreatorUserID, ChannelRoleAdmin); err != nil {
			return err
		}
		initialUsers := dedupeFilter(in.InitialUserIDs, in.CreatorUserID)
		if len(initialUsers) > 0 {
			for _, userID := range initialUsers {
				role, err := s.humanServerRole(ctx, tx, in.WorkspaceID, userID)
				if err != nil {
					return err
				}
				if role == "" {
					return &DomainError{Code: CodeInvalidInput, Message: "One or more initial users are not members of this server"}
				}
			}
			for _, userID := range initialUsers {
				if _, err := s.addHumanRow(ctx, tx, channel.ID, userID, ChannelRoleMember); err != nil {
					return err
				}
			}
		}
		initialAgents := dedupeFilter(in.InitialAgentIDs, "")
		if len(initialAgents) > 0 {
			for _, agentID := range initialAgents {
				exists, err := s.AgentExistsInWorkspace(ctx, tx, agentID, in.WorkspaceID)
				if err != nil {
					return err
				}
				if !exists {
					return &DomainError{Code: CodeInvalidInput, Message: "One or more initial agents are not active in this server"}
				}
			}
			for _, agentID := range initialAgents {
				if _, err := s.addAgentRow(ctx, tx, channel.ID, agentID, ChannelRoleMember); err != nil {
					return err
				}
			}
		}
		// The channel's durable appearance: one channel:updated intent for
		// the whole creation (the TS route publishes the created channel to
		// the authorized server audience after the response).
		if err := s.enqueueChannelUpdated(ctx, tx, in.WorkspaceID, channel.ID); err != nil {
			return err
		}
		created = channel
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

func dedupeFilter(ids []string, exclude string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == exclude || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

// createChannelTx ports createChannelWithExecutor: reserved names, the plan
// quota branch (free = unlimited; kept for parity), and the name-uniqueness
// precheck whose race loser is arbitrated by the partial unique index.
func (s *Store) createChannelTx(ctx context.Context, tx *sql.Tx, workspaceID, name string, description *string, channelType string) (*Channel, error) {
	if name == systemAllName {
		return nil, &DomainError{Code: CodeInvalidInput, Message: `Channel name "all" is reserved`}
	}
	if name == announcementName {
		return nil, &DomainError{Code: CodeInvalidInput, Message: `Channel name "announcement" is reserved`}
	}
	var plan string
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(plan, 'free') FROM workspaces WHERE id = ?`, workspaceID).Scan(&plan); err != nil {
		if err == sql.ErrNoRows {
			return nil, &DomainError{Code: CodeNotFound, Message: "Server not found"}
		}
		return nil, fmt.Errorf("read workspace plan: %w", err)
	}
	maxChannels := -1 // free plan (frozen policy: no paid plans exist here)
	if maxChannels != -1 {
		var count int
		if err := tx.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM channels
			WHERE workspace_id = ? AND type IN ('channel', 'private') AND deleted_at IS NULL`,
			workspaceID).Scan(&count); err != nil {
			return nil, err
		}
		if count >= maxChannels {
			return nil, &DomainError{Code: CodeForbidden, Message: fmt.Sprintf("Channel limit reached (%d/%d on %s plan). Upgrade for more.", count, maxChannels, "Free")}
		}
	}
	var existingID string
	var existingArchived sql.NullInt64
	var existingType string
	err := tx.QueryRowContext(ctx, `
		SELECT id, archived_at, type FROM channels
		WHERE workspace_id = ? AND type IN (?, ?, ?) AND name = ? AND deleted_at IS NULL`,
		workspaceID, TypeChannel, TypePrivate, TypeJoint, name).Scan(&existingID, &existingArchived, &existingType)
	if err == nil {
		if existingArchived.Valid {
			return nil, &ArchivedNameCollisionError{
				ChannelName:         name,
				ArchivedChannelID:   existingID,
				ArchivedChannelType: existingType,
			}
		}
		return nil, &DomainError{Code: CodeConflict, Message: fmt.Sprintf("Channel name %q is already taken", name)}
	}
	if err != sql.ErrNoRows {
		return nil, fmt.Errorf("precheck channel name: %w", err)
	}
	id, err := newUUID()
	if err != nil {
		return nil, err
	}
	var descriptionArg any
	if description != nil {
		descriptionArg = *description
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, description, type, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		id, workspaceID, name, descriptionArg, channelType, s.now().UnixMilli()); err != nil {
		// The unique index sees races the precheck cannot.
		if isUniqueViolation(err) {
			if collision := s.findArchivedCollision(ctx, tx, workspaceID, name); collision != nil {
				return nil, collision
			}
			return nil, &DomainError{Code: CodeConflict, Message: fmt.Sprintf("Channel name %q is already taken", name)}
		}
		return nil, fmt.Errorf("insert channel: %w", err)
	}
	return s.getChannel(ctx, tx, id, false)
}

// findArchivedCollision re-reads the losing race to classify the conflict.
func (s *Store) findArchivedCollision(ctx context.Context, tx *sql.Tx, workspaceID, name string) *ArchivedNameCollisionError {
	var id, channelType string
	var archivedAt sql.NullInt64
	err := tx.QueryRowContext(ctx, `
		SELECT id, archived_at, type FROM channels
		WHERE workspace_id = ? AND type IN (?, ?, ?) AND name = ? AND deleted_at IS NULL`,
		workspaceID, TypeChannel, TypePrivate, TypeJoint, name).Scan(&id, &archivedAt, &channelType)
	if err == nil && archivedAt.Valid {
		return &ArchivedNameCollisionError{ChannelName: name, ArchivedChannelID: id, ArchivedChannelType: channelType}
	}
	return nil
}

func isUniqueViolation(err error) bool {
	return platformdb.IsUniqueViolation(err, "")
}

// ChannelUpdates is the PATCH payload after route validation (nil = absent).
type ChannelUpdates struct {
	Name          *string
	Description   *string
	Type          *string // "channel" | "private"
	GuestVisible  *bool
	GuestJoinable *bool
}

// UpdateChannel ports channelService.updateChannel (non-joint reachable
// shapes; joint guards retained for parity).
func (s *Store) UpdateChannel(ctx context.Context, workspaceID, actorUserID, channelID string, updates ChannelUpdates) (*Channel, error) {
	var updated *Channel
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, false)
		if err != nil {
			return err
		}
		if channel == nil || channel.WorkspaceID != workspaceID {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		if err := s.authorizeUpdate(ctx, tx, channel, actorUserID, updates); err != nil {
			return err
		}
		if channel.ArchivedAt != nil {
			return &DomainError{Code: CodeConflict, Message: "This channel is archived"}
		}
		regular := channel.Type == TypeChannel || channel.Type == TypePrivate
		if !regular && channel.Type != TypeJoint {
			return &DomainError{Code: CodeForbidden, Message: "Cannot edit DM channels"}
		}
		if channel.Type == TypeJoint && updates.Type != nil {
			return &DomainError{Code: CodeForbidden, Message: "Cannot change visibility for joint channels"}
		}
		guestPolicyRequested := updates.GuestVisible != nil || updates.GuestJoinable != nil
		if guestPolicyRequested && channel.Type != TypeChannel && channel.Type != TypePrivate {
			return &DomainError{Code: CodeInvalidInput, Message: "Guest access is supported only for ordinary channels"}
		}
		if IsAllSystemChannel(channel) && updates.Name != nil && *updates.Name != systemAllName {
			return &DomainError{Code: CodeForbidden, Message: "Cannot rename the #all channel"}
		}
		if IsAllSystemChannel(channel) && updates.GuestJoinable != nil && *updates.GuestJoinable {
			return &DomainError{Code: CodeInvalidInput, Message: "The #all channel does not support Guest joining"}
		}
		if !IsAllSystemChannel(channel) && updates.Name != nil && *updates.Name == systemAllName {
			return &DomainError{Code: CodeInvalidInput, Message: `Channel name "all" is reserved`}
		}
		if IsAnnouncementChannel(channel) &&
			(updates.Name != nil || updates.Type != nil || updates.GuestVisible != nil || updates.GuestJoinable != nil) {
			return &DomainError{Code: CodeForbidden, Message: "Cannot rename or change visibility of the #announcement channel"}
		}
		if !IsAnnouncementChannel(channel) && updates.Name != nil && *updates.Name == announcementName {
			return &DomainError{Code: CodeInvalidInput, Message: `Channel name "announcement" is reserved`}
		}
		allSystemVisibilityUpdate := IsAllSystemChannel(channel) &&
			updates.Type != nil && *updates.Type != channel.Type

		// Rename uniqueness (single projection in this phase).
		if updates.Name != nil && *updates.Name != channel.Name {
			var existingID string
			err := tx.QueryRowContext(ctx, `
				SELECT id FROM channels
				WHERE workspace_id = ? AND type IN (?, ?, ?) AND name = ? AND id <> ? AND deleted_at IS NULL`,
				channel.WorkspaceID, TypeChannel, TypePrivate, TypeJoint, *updates.Name, channelID).Scan(&existingID)
			if err == nil {
				return &DomainError{Code: CodeConflict, Message: fmt.Sprintf("Channel name %q is already taken", *updates.Name)}
			}
			if err != sql.ErrNoRows {
				return fmt.Errorf("precheck rename: %w", err)
			}
		}

		nextType := channel.Type
		if updates.Type != nil {
			nextType = *updates.Type
		}
		nextGuestVisible := channel.GuestVisible
		if nextType == TypePrivate && !IsAllSystemChannel(channel) {
			nextGuestVisible = false
		} else if updates.GuestVisible != nil {
			nextGuestVisible = *updates.GuestVisible
		}
		nextGuestJoinable := false
		switch {
		case IsAllSystemChannel(channel):
			nextGuestJoinable = false
		case nextType == TypePrivate:
			nextGuestJoinable = false
		case updates.GuestJoinable != nil:
			nextGuestJoinable = *updates.GuestJoinable
		default:
			nextGuestJoinable = channel.GuestJoinable
		}
		if nextGuestJoinable && !nextGuestVisible {
			return &DomainError{Code: CodeInvalidInput, Message: "Guest-joinable channels must also be guest-visible"}
		}

		sets := []string{}
		args := []any{}
		if updates.Name != nil {
			sets = append(sets, "name = ?")
			args = append(args, *updates.Name)
		}
		if updates.Description != nil {
			sets = append(sets, "description = ?")
			if *updates.Description == "" {
				args = append(args, nil) // TS stores description || null
			} else {
				args = append(args, *updates.Description)
			}
		}
		if updates.Type != nil && *updates.Type != channel.Type {
			sets = append(sets, "type = ?")
			args = append(args, *updates.Type)
		}
		if updates.GuestVisible != nil || (nextType == TypePrivate && !IsAllSystemChannel(channel)) {
			sets = append(sets, "guest_visible = ?")
			args = append(args, boolArg(nextGuestVisible))
		}
		if IsAllSystemChannel(channel) || updates.GuestJoinable != nil || nextType == TypePrivate {
			sets = append(sets, "guest_joinable = ?")
			args = append(args, boolArg(nextGuestJoinable))
		}
		if len(sets) == 0 {
			updated = channel
			return nil
		}
		args = append(args, channelID)
		if _, err := tx.ExecContext(ctx,
			`UPDATE channels SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
			if isUniqueViolation(err) {
				return &DomainError{Code: CodeConflict, Message: fmt.Sprintf("Channel name %q is already taken", deref(updates.Name))}
			}
			return fmt.Errorf("update channel: %w", err)
		}
		// Only a real transition publishes (a no-field/no-change PATCH never
		// reaches here): the durable channel:updated intent rides the same
		// transaction as the row it describes.
		if err := s.enqueueChannelUpdated(ctx, tx, channel.WorkspaceID, channelID); err != nil {
			return err
		}
		// Hiding #all drops the whole derived audience at once: no rows may
		// survive as explicit membership.
		if allSystemVisibilityUpdate && updates.Type != nil && *updates.Type == TypePrivate {
			if _, err := tx.ExecContext(ctx, `DELETE FROM channel_humans WHERE channel_id = ?`, channelID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM channel_agents WHERE channel_id = ?`, channelID); err != nil {
				return err
			}
		}
		updated, err = s.getChannel(ctx, tx, channelID, false)
		return err
	})
	if err != nil {
		return nil, err
	}
	return updated, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func boolArg(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ArchiveChannel ports archiveChannel: idempotent, refusal for system
// channels and non-regular types, actor recorded, conditional UPDATE so two
// concurrent archives cannot both claim the transition.
func (s *Store) ArchiveChannel(ctx context.Context, workspaceID, channelID, archivedByUserID string) (*Channel, error) {
	var result *Channel
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, false)
		if err != nil {
			return err
		}
		if channel == nil || channel.WorkspaceID != workspaceID {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		regular := channel.Type == TypeChannel || channel.Type == TypePrivate
		if !regular && channel.Type != TypeJoint {
			return &DomainError{Code: CodeInvalidInput, Message: "Only regular channels can be archived"}
		}
		if err := s.authorizeArchive(ctx, tx, channel, archivedByUserID); err != nil {
			return err
		}
		if IsAllSystemChannel(channel) {
			return &DomainError{Code: CodeInvalidInput, Message: "The #all channel cannot be archived"}
		}
		if IsAnnouncementChannel(channel) {
			return &DomainError{Code: CodeInvalidInput, Message: "The #announcement channel cannot be archived"}
		}
		if channel.ArchivedAt != nil {
			result = channel
			return nil
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE channels SET archived_at = ?, archived_by_user_id = ?, archived_by_agent_id = NULL
			WHERE id = ? AND archived_at IS NULL`,
			s.now().UnixMilli(), archivedByUserID, channelID)
		if err != nil {
			return fmt.Errorf("archive channel: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			unchanged, err := s.getChannel(ctx, tx, channelID, false)
			if err != nil || unchanged == nil {
				return err
			}
			result = unchanged
			return nil
		}
		if err := s.enqueueChannelUpdated(ctx, tx, channel.WorkspaceID, channelID); err != nil {
			return err
		}
		result, err = s.getChannel(ctx, tx, channelID, false)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// UnarchiveChannel ports unarchiveChannel (idempotent conditional UPDATE).
func (s *Store) UnarchiveChannel(ctx context.Context, workspaceID, channelID, userID string) (*Channel, error) {
	var result *Channel
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, false)
		if err != nil {
			return err
		}
		if channel == nil || channel.WorkspaceID != workspaceID {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		regular := channel.Type == TypeChannel || channel.Type == TypePrivate
		if !regular && channel.Type != TypeJoint {
			return &DomainError{Code: CodeInvalidInput, Message: "Only regular channels can be unarchived"}
		}
		if err := s.authorizeArchive(ctx, tx, channel, userID); err != nil {
			return err
		}
		if channel.ArchivedAt == nil {
			result = channel
			return nil
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE channels SET archived_at = NULL, archived_by_user_id = NULL, archived_by_agent_id = NULL
			WHERE id = ?`, channelID)
		if err != nil {
			return fmt.Errorf("unarchive channel: %w", err)
		}
		_ = res
		if err := s.enqueueChannelUpdated(ctx, tx, channel.WorkspaceID, channelID); err != nil {
			return err
		}
		result, err = s.getChannel(ctx, tx, channelID, false)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// DeleteChannel ports deleteChannel: soft delete with system-channel
// refusals. The TS task-closing hook has no tasks table here (M6 domain); no
// message or membership cleanup exists to do.
func (s *Store) DeleteChannel(ctx context.Context, workspaceID, channelID, userID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, true)
		if err != nil {
			return err
		}
		if channel == nil {
			return nil
		}
		if channel.WorkspaceID != workspaceID {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		role, err := s.eligibleHumanRole(ctx, tx, workspaceID, userID)
		if err != nil {
			return err
		}
		if channel.Type == TypeDM {
			if role == "" {
				return &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
			}
			member, err := s.isChannelHuman(ctx, tx, channelID, userID)
			if err != nil {
				return err
			}
			if !member {
				return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
			}
		} else if role == "" || !HasServerCapability(role, CapDeleteChannels) {
			return &DomainError{Code: CodeForbidden, Message: "Only admins can delete channels"}
		} else if channel.Type == TypePrivate {
			member, err := s.isChannelHuman(ctx, tx, channelID, userID)
			if err != nil {
				return err
			}
			if !member {
				return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
			}
		}
		if IsAllSystemChannel(channel) {
			return &DomainError{Code: CodeForbidden, Message: "The #all channel cannot be deleted"}
		}
		if IsAnnouncementChannel(channel) {
			return &DomainError{Code: CodeForbidden, Message: "The #announcement channel cannot be deleted"}
		}
		if channel.DeletedAt != nil {
			return nil
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE channels SET deleted_at = ? WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
			s.now().UnixMilli(), channelID, workspaceID); err != nil {
			return fmt.Errorf("delete channel: %w", err)
		}
		// Deliberately NO channel:updated / channel:members-updated intent:
		// the frozen TS server emits nothing on channel deletion (the joint
		// disconnect route's bare {channelId} frame is a different mutation),
		// and revoked visibility is enforced fail-closed by the realtime
		// authority layers, never by these notifications.
		return nil
	})
}

// JoinChannel ports the POST /:id/join route logic (typed failures). The
// channel binding, live role, and join capability are decided in the same
// transaction as the membership insert.
func (s *Store) JoinChannel(ctx context.Context, workspaceID, channelID, userID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, false)
		if err != nil {
			return err
		}
		if channel == nil || channel.WorkspaceID != workspaceID {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		switch channel.Type {
		case TypeThread:
			return &DomainError{Code: CodeInvalidInput, Message: "Thread membership is managed via follow/unfollow"}
		case TypeDM:
			return &DomainError{Code: CodeForbidden, Message: "Cannot join DM channels"}
		case TypePrivate:
			return &DomainError{Code: CodeForbidden, Message: "Private channels require an invitation"}
		case TypeJoint:
			return &DomainError{Code: CodeForbidden, Message: "Joint channels require an admin invitation"}
		}
		if channel.ArchivedAt != nil {
			return &DomainError{Code: CodeConflict, Message: "This channel is archived"}
		}
		serverRole, err := s.eligibleHumanRole(ctx, tx, workspaceID, userID)
		if err != nil {
			return err
		}
		if serverRole == "" {
			return &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
		}
		isGuest := serverRole == RoleGuest
		if !isGuest && HasImplicitServerMembership(channel) {
			return nil // already a member by derivation
		}
		member, err := s.isChannelHuman(ctx, tx, channelID, userID)
		if err != nil {
			return err
		}
		if member {
			return nil
		}
		if isGuest {
			outcome, err := s.addGuestHumanIfAllowedTx(ctx, tx, channelID, userID)
			if err != nil {
				return err
			}
			if outcome == GuestJoinForbidden {
				return &DomainError{Code: CodeForbidden, Message: "Guest policy does not allow joining this channel"}
			}
			return nil
		}
		if !HasServerCapability(serverRole, CapJoinPublicChannels) {
			return &DomainError{Code: CodeForbidden, Message: "Server role cannot join public channels"}
		}
		_, err = s.AddHuman(ctx, channelID, userID, "", tx)
		return err
	})
}

// LeaveChannel ports the POST /:id/leave route logic. Access, membership, and
// the roster delete share one transaction, so a membership loss cannot
// soft-delete an empty private channel.
func (s *Store) LeaveChannel(ctx context.Context, workspaceID, channelID, userID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, false)
		if err != nil {
			return err
		}
		if channel == nil || channel.WorkspaceID != workspaceID {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		role, err := s.eligibleHumanRole(ctx, tx, workspaceID, userID)
		if err != nil {
			return err
		}
		if role == "" {
			return &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
		}
		access, err := s.userCanAccessChannel(ctx, tx, channel, workspaceID, userID, role)
		if err != nil {
			return err
		}
		if !access {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		switch channel.Type {
		case TypeThread:
			return &DomainError{Code: CodeInvalidInput, Message: "Thread membership is managed via follow/unfollow"}
		case TypeDM:
			return &DomainError{Code: CodeForbidden, Message: "Cannot leave DM channels"}
		}
		if channel.ArchivedAt != nil {
			return &DomainError{Code: CodeConflict, Message: "This channel is archived"}
		}
		return s.RemoveHuman(ctx, channelID, userID, tx)
	})
}

// RoleChangeResult is the PATCH .../role response payload.
type RoleChangeResult struct {
	Changed           bool    `json:"changed"`
	ChannelID         string  `json:"channelId"`
	TargetType        string  `json:"targetType"`
	TargetID          string  `json:"targetId"`
	ChannelRole       string  `json:"channelRole"`
	AuthorityRevision int64   `json:"authorityRevision"`
	EventID           *string `json:"eventId"`
}

// ChangeChannelMembershipRole ports channelService.changeChannelMembershipRole
// including the durable outbox event committed with the mutation.
func (s *Store) ChangeChannelMembershipRole(ctx context.Context, workspaceID, channelID, requesterUserID, targetType, targetID, nextRole string) (*RoleChangeResult, error) {
	result := &RoleChangeResult{}
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, false)
		if err != nil {
			return err
		}
		if channel == nil || channel.WorkspaceID != workspaceID {
			return &RoleMutationError{Code: RoleCodeChannelNotFound, Message: "Channel not found"}
		}
		if (channel.Type != TypeChannel && channel.Type != TypePrivate) || IsAllSystemChannel(channel) {
			return &RoleMutationError{Code: RoleCodeUnsupportedShape, Message: "Channel roles are supported only for regular public or private channels"}
		}
		if channel.ArchivedAt != nil {
			return &RoleMutationError{Code: RoleCodeChannelArchived, Message: "This channel is archived"}
		}

		requesterRole, err := s.eligibleHumanRole(ctx, tx, workspaceID, requesterUserID)
		if err != nil {
			return err
		}
		var requesterChannelRole sql.NullString
		if err := tx.QueryRowContext(ctx, `
			SELECT role FROM channel_humans WHERE channel_id = ? AND user_id = ?`,
			channelID, requesterUserID).Scan(&requesterChannelRole); err != nil && err != sql.ErrNoRows {
			return err
		}
		requesterMember := requesterChannelRole.Valid
		requesterCanAccess := channel.Type == TypeChannel || requesterMember
		requesterAllowed := requesterCanAccess && HasEffectiveChannelCapability(
			requesterRole, nullStrValue(requesterChannelRole), requesterMember, true, CapChangeChannelRoles)
		if !requesterAllowed {
			return &RoleMutationError{Code: RoleCodeCapabilityRequired, Message: "You do not have permission to change channel member roles"}
		}
		if targetType == "user" && targetID == requesterUserID {
			code := RoleCodeMembershipConflict
			if nextRole == ChannelRoleMember {
				code = RoleCodeAdminSelfDemote
			}
			return &RoleMutationError{Code: code, Message: "A channel admin cannot change their own channel role"}
		}

		var previousRole string
		var revision int64
		if targetType == "user" {
			err = tx.QueryRowContext(ctx, `
				SELECT role, authority_revision FROM channel_humans
				WHERE channel_id = ? AND user_id = ?`, channelID, targetID).Scan(&previousRole, &revision)
		} else {
			err = tx.QueryRowContext(ctx, `
				SELECT role, authority_revision FROM channel_agents
				WHERE channel_id = ? AND agent_id = ?`, channelID, targetID).Scan(&previousRole, &revision)
		}
		if err == sql.ErrNoRows {
			return &RoleMutationError{Code: RoleCodeMemberRequired, Message: "Target must already be a channel member"}
		}
		if err != nil {
			return err
		}

		var targetServerRole string
		if targetType == "user" {
			targetServerRole, err = s.humanServerRole(ctx, tx, workspaceID, targetID)
		} else {
			targetServerRole, err = s.AgentServerRole(ctx, tx, workspaceID, targetID)
		}
		if err != nil {
			return err
		}
		if targetServerRole == RoleOwner || targetServerRole == RoleAdmin {
			return &RoleMutationError{Code: RoleCodeProtectedServerRole, Message: "Server owners and admins cannot be changed from channel role management"}
		}
		if targetServerRole == RoleGuest && nextRole == ChannelRoleAdmin {
			return &RoleMutationError{Code: RoleCodeGuestAdminForbidden, Message: "Guests cannot be promoted to channel admin"}
		}

		if previousRole == nextRole {
			*result = RoleChangeResult{
				Changed: false, ChannelID: channelID, TargetType: targetType, TargetID: targetID,
				ChannelRole: previousRole, AuthorityRevision: revision, EventID: nil,
			}
			return nil
		}

		nextRevision := revision + 1
		if targetType == "user" {
			_, err = tx.ExecContext(ctx, `
				UPDATE channel_humans SET role = ?, authority_revision = ?
				WHERE channel_id = ? AND user_id = ?`, nextRole, nextRevision, channelID, targetID)
		} else {
			_, err = tx.ExecContext(ctx, `
				UPDATE channel_agents SET role = ?, authority_revision = ?
				WHERE channel_id = ? AND agent_id = ?`, nextRole, nextRevision, channelID, targetID)
		}
		if err != nil {
			return fmt.Errorf("update channel role: %w", err)
		}
		eventID, err := newUUID()
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO channel_membership_role_events
				(id, channel_id, workspace_id, requester_user_id, target_type, target_id,
				 previous_role, next_role, authority_revision, delivery_status, delivery_attempts, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
			eventID, channelID, workspaceID, requesterUserID, targetType, targetID,
			previousRole, nextRole, nextRevision, s.now().UnixMilli()); err != nil {
			return fmt.Errorf("insert role event: %w", err)
		}
		// Real role transitions emit the TS members-updated pair; the subject
		// reference drives the targeted user projection exactly like the TS
		// role route (agent targets have no targeted frame). No-change PATCH
		// requests already returned above and record nothing.
		subjectUserID := ""
		if targetType == "user" {
			subjectUserID = targetID
		}
		if err := s.enqueueMembersUpdated(ctx, tx, workspaceID, channelID, subjectUserID); err != nil {
			return err
		}
		*result = RoleChangeResult{
			Changed: true, ChannelID: channelID, TargetType: targetType, TargetID: targetID,
			ChannelRole: nextRole, AuthorityRevision: nextRevision, EventID: &eventID,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func nullStrValue(v sql.NullString) string {
	if !v.Valid {
		return ""
	}
	return v.String
}
