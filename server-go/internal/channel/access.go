// Channel access and authority resolution, porting resolveChannelActorContext,
// channelActorHasCapability and canUserAccessChannel. Thread/DM recursion into
// parents is intentionally absent for threads (no thread channels can exist
// without messages, M4) and kept for DM participant rows (no writer exists in
// this phase, but the read rule stays faithful).
package channel

import (
	"context"
	"database/sql"
	"fmt"
)

// ActorContext ports ChannelActorContext for one (workspace, channel, actor).
type ActorContext struct {
	ActorType                string // "user" | "agent"
	ActorID                  string
	ServerID                 string
	ChannelID                string
	Channel                  *Channel
	ServerRole               string // "" = none
	ChannelRole              string // "" = no stored row
	ChannelAuthorityRevision int64
	IsChannelMember          bool
	CanAccessChannel         bool
	SupportsChannelRoles     bool
}

// ResolveChannelActorContext ports resolveChannelActorContext: nil when the
// channel does not exist in this workspace or the actor holds no server role.
func (s *Store) ResolveChannelActorContext(ctx context.Context, workspaceID, channelID, actorType, actorID string) (*ActorContext, error) {
	return s.resolveChannelActorContext(ctx, s.db, workspaceID, channelID, actorType, actorID)
}

func (s *Store) resolveChannelActorContext(ctx context.Context, ex Executor, workspaceID, channelID, actorType, actorID string) (*ActorContext, error) {
	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return nil, err
	}
	if channel == nil || channel.WorkspaceID != workspaceID {
		return nil, nil
	}
	serverRole := ""
	if actorType == "agent" {
		serverRole, err = s.AgentServerRole(ctx, ex, workspaceID, actorID)
	} else {
		serverRole, err = s.humanServerRole(ctx, ex, workspaceID, actorID)
	}
	if err != nil {
		return nil, err
	}
	if serverRole == "" {
		return nil, nil
	}

	var channelRole string
	var revision int64
	isChannelMember := false
	if actorType == "agent" {
		err = ex.QueryRowContext(ctx, `
			SELECT role, authority_revision FROM channel_agents
			WHERE channel_id = ? AND agent_id = ?`, channelID, actorID).Scan(&channelRole, &revision)
	} else {
		err = ex.QueryRowContext(ctx, `
			SELECT role, authority_revision FROM channel_humans
			WHERE channel_id = ? AND user_id = ?`, channelID, actorID).Scan(&channelRole, &revision)
	}
	if err == sql.ErrNoRows {
		isChannelMember, channelRole, revision = false, "", 0
	} else if err != nil {
		return nil, fmt.Errorf("read channel membership: %w", err)
	} else {
		isChannelMember = true
	}

	supportsRoles := SupportsChannelRoles(channel.Type, channel.Name)
	canAccess := false
	switch channel.Type {
	case TypeChannel:
		canAccess = true
	case TypePrivate, TypeJoint:
		canAccess = isChannelMember
	}

	return &ActorContext{
		ActorType:                actorType,
		ActorID:                  actorID,
		ServerID:                 workspaceID,
		ChannelID:                channelID,
		Channel:                  channel,
		ServerRole:               serverRole,
		ChannelRole:              channelRole,
		ChannelAuthorityRevision: revision,
		IsChannelMember:          isChannelMember,
		CanAccessChannel:         canAccess,
		SupportsChannelRoles:     supportsRoles,
	}, nil
}

// ChannelActorHasCapability ports channelActorHasCapability.
func ChannelActorHasCapability(ctxx *ActorContext, capability string) bool {
	if capability == CapAddChannelMembers {
		return CanAddChannelMembers(
			ctxx.ServerRole, ctxx.IsChannelMember, ctxx.Channel.Type, ctxx.Channel.Name,
			ctxx.Channel.ArchivedAt != nil, ctxx.Channel.DeletedAt != nil)
	}
	return ctxx.CanAccessChannel && HasEffectiveChannelCapability(
		ctxx.ServerRole, ctxx.ChannelRole, ctxx.IsChannelMember, ctxx.SupportsChannelRoles, capability)
}

// ActorHasChannelCapability resolves the context and decides one capability.
func (s *Store) ActorHasChannelCapability(ctx context.Context, workspaceID, channelID, actorType, actorID, capability string) (bool, error) {
	ac, err := s.ResolveChannelActorContext(ctx, workspaceID, channelID, actorType, actorID)
	if err != nil {
		return false, err
	}
	return ac != nil && ChannelActorHasCapability(ac, capability), nil
}

// CapabilityMap projects the closed CHANNEL_MANAGEMENT_CAPABILITIES set for
// list/detail responses (attachHumanChannelAuthorization); nil context yields
// all-false.
func CapabilityMap(ac *ActorContext) map[string]bool {
	out := make(map[string]bool, len(ChannelManagementCapabilities))
	for _, capability := range ChannelManagementCapabilities {
		out[capability] = ac != nil && ChannelActorHasCapability(ac, capability)
	}
	return out
}

// AuthorityRevision returns the stored revision, or nil without a row.
func AuthorityRevision(ac *ActorContext) *int64 {
	if ac == nil || !ac.IsChannelMember {
		return nil
	}
	v := ac.ChannelAuthorityRevision
	return &v
}

// CanUserAccessChannel ports channelService.canUserAccessChannel for the
// shapes reachable in this phase: cross-workspace guard, hidden-#all guard,
// public readability, DM participant scope, private explicit membership, and
// the fail-closed guest gate.
func (s *Store) CanUserAccessChannel(ctx context.Context, workspaceID, channelID, userID string) (bool, error) {
	channel, err := s.GetChannel(ctx, channelID)
	if err != nil {
		return false, err
	}
	if channel == nil || channel.WorkspaceID != workspaceID {
		return false, nil
	}
	serverRole, err := s.HumanServerRole(ctx, workspaceID, userID)
	if err != nil {
		return false, err
	}
	if serverRole == RoleGuest {
		member, err := s.IsChannelHuman(ctx, channelID, userID)
		if err != nil {
			return false, err
		}
		return CanGuestReadChannel(false, /* gate disabled (frozen policy) */
			serverRole, channel.Type, channel.Name,
			IsAllSystemChannel(channel) && !IsEnabledAllChannel(channel),
			channel.GuestVisible, channel.GuestJoinable, member,
			channel.ArchivedAt != nil, channel.DeletedAt != nil), nil
	}
	if IsAllSystemChannel(channel) && !IsEnabledAllChannel(channel) {
		return false, nil
	}
	if channel.Type == TypeChannel {
		return true, nil
	}
	if channel.Type == TypeDM {
		var one int
		err := s.db.QueryRowContext(ctx, `
			SELECT 1 FROM channel_humans WHERE channel_id = ? AND user_id = ?`,
			channelID, userID).Scan(&one)
		if err == sql.ErrNoRows {
			return false, nil
		}
		return err == nil, err
	}
	member, err := s.IsChannelHuman(ctx, channelID, userID)
	if err != nil {
		return false, err
	}
	return member, nil
}

// IsChannelHuman: does the user hold a channel_humans row.
func (s *Store) IsChannelHuman(ctx context.Context, channelID, userID string) (bool, error) {
	return s.isChannelHuman(ctx, s.db, channelID, userID)
}

func (s *Store) isChannelHuman(ctx context.Context, ex Executor, channelID, userID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx,
		`SELECT 1 FROM channel_humans WHERE channel_id = ? AND user_id = ?`, channelID, userID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read channel_humans: %w", err)
	}
	return true, nil
}

// userCanAccessChannel is the leave/delete snapshot of CanUserAccessChannel.
// An empty server role cannot access: the public read path treats a missing
// role like a non-guest, and a write must not inherit that.
func (s *Store) userCanAccessChannel(ctx context.Context, ex Executor, channel *Channel, workspaceID, userID, serverRole string) (bool, error) {
	if channel == nil || channel.WorkspaceID != workspaceID || serverRole == "" {
		return false, nil
	}
	if serverRole == RoleGuest {
		member, err := s.isChannelHuman(ctx, ex, channel.ID, userID)
		if err != nil {
			return false, err
		}
		return CanGuestReadChannel(false, /* gate disabled (frozen policy) */
			serverRole, channel.Type, channel.Name,
			IsAllSystemChannel(channel) && !IsEnabledAllChannel(channel),
			channel.GuestVisible, channel.GuestJoinable, member,
			channel.ArchivedAt != nil, channel.DeletedAt != nil), nil
	}
	if IsAllSystemChannel(channel) && !IsEnabledAllChannel(channel) {
		return false, nil
	}
	if channel.Type == TypeChannel {
		return true, nil
	}
	member, err := s.isChannelHuman(ctx, ex, channel.ID, userID)
	if err != nil {
		return false, err
	}
	return member, nil
}

// IsChannelAgent: does the agent hold a channel_agents row.
func (s *Store) IsChannelAgent(ctx context.Context, channelID, agentID string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM channel_agents WHERE channel_id = ? AND agent_id = ?`, channelID, agentID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read channel_agents: %w", err)
	}
	return true, nil
}
