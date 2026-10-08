// Live authorization for channel writes. Handlers may pre-check so a stable
// request keeps the TS sentence; the committing transaction re-reads
// membership, role, capability, and channel binding and rolls back when any
// of those no longer hold. The predicate matches RequireChannelServer
// (deleted and joint_storage workspaces do not count).
package channel

import (
	"context"
	"database/sql"
)

func capabilityRequired() error {
	return &DomainError{Code: CodeForbidden, Message: CapabilityRequiredMessage}
}

// eligibleHumanRole is the actor's live workspace role inside the caller's
// transaction. "" means the middleware would now reject the request.
func (s *Store) eligibleHumanRole(ctx context.Context, ex Executor, workspaceID, userID string) (string, error) {
	var role string
	err := ex.QueryRowContext(ctx, `
		SELECT m.role
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ?
		  AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
		workspaceID, userID).Scan(&role)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return role, nil
}

// revalidateHumanCapabilities re-reads the channel binding and the actor,
// then requires every capability. A missing channel in this workspace is not
// found; a missing membership or a failed capability is the TS lock error.
func (s *Store) revalidateHumanCapabilities(ctx context.Context, ex Executor, workspaceID, channelID, userID string, capabilities []string) (*ActorContext, error) {
	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return nil, err
	}
	if channel == nil || channel.WorkspaceID != workspaceID {
		return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}
	role, err := s.eligibleHumanRole(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, capabilityRequired()
	}
	ac, err := s.resolveChannelActorContext(ctx, ex, workspaceID, channelID, "user", userID)
	if err != nil {
		return nil, err
	}
	if ac == nil {
		return nil, capabilityRequired()
	}
	ac.ServerRole = role
	for _, capability := range capabilities {
		if !ChannelActorHasCapability(ac, capability) {
			return nil, capabilityRequired()
		}
	}
	return ac, nil
}

// authorizeUpdate is the PATCH / hide / restore fence. #all visibility is a
// server capability (no membership row exists). Every other update uses the
// channel-actor matrix, and a visibility change also requires a membership row.
func (s *Store) authorizeUpdate(ctx context.Context, tx *sql.Tx, channel *Channel, userID string, updates ChannelUpdates) error {
	onlyAllVisibility := updates.Type != nil && IsAllSystemChannel(channel) &&
		updates.Name == nil && updates.Description == nil &&
		updates.GuestVisible == nil && updates.GuestJoinable == nil
	if onlyAllVisibility {
		role, err := s.eligibleHumanRole(ctx, tx, channel.WorkspaceID, userID)
		if err != nil {
			return err
		}
		if role == "" || !HasServerCapability(role, CapChangeChannelVis) {
			return capabilityRequired()
		}
		return nil
	}
	caps := make([]string, 0, 3)
	if updates.Name != nil || updates.Description != nil {
		caps = append(caps, CapEditChannelMetadata)
	}
	if updates.Type != nil {
		caps = append(caps, CapChangeChannelVis)
	}
	if updates.GuestVisible != nil || updates.GuestJoinable != nil {
		caps = append(caps, CapManageGuestAccess)
	}
	if len(caps) == 0 {
		caps = append(caps, CapEditChannelMetadata)
	}
	if _, err := s.revalidateHumanCapabilities(ctx, tx, channel.WorkspaceID, channel.ID, userID, caps); err != nil {
		return err
	}
	if updates.Type != nil && !IsAllSystemChannel(channel) {
		member, err := s.isChannelHuman(ctx, tx, channel.ID, userID)
		if err != nil {
			return err
		}
		if !member {
			return &DomainError{Code: CodeForbidden, Message: VisibilityMembershipRequiredMessage}
		}
	}
	return nil
}

// authorizeArchive is the archive/unarchive fence: regular channels use the
// channel-actor capability (so a private channel still requires access);
// joint channels, if a row is ever reached, use the server capability.
func (s *Store) authorizeArchive(ctx context.Context, tx *sql.Tx, channel *Channel, userID string) error {
	regular := channel.Type == TypeChannel || channel.Type == TypePrivate
	if regular {
		_, err := s.revalidateHumanCapabilities(ctx, tx, channel.WorkspaceID, channel.ID, userID, []string{CapArchiveChannels})
		return err
	}
	if channel.Type != TypeJoint {
		return nil
	}
	role, err := s.eligibleHumanRole(ctx, tx, channel.WorkspaceID, userID)
	if err != nil {
		return err
	}
	if role == "" || !HasServerCapability(role, CapArchiveChannels) {
		return capabilityRequired()
	}
	return nil
}

// CommitAuthorized runs fn in one write transaction after the actor's live
// membership, channel binding, and capabilities have been re-read. fn is not
// called when that recheck fails. An archived channel is refused after the
// capability check so a remove that raced an archive does not commit.
func (s *Store) CommitAuthorized(ctx context.Context, workspaceID, channelID, userID string, capabilities []string, fn func(tx Executor) error) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		ac, err := s.revalidateHumanCapabilities(ctx, tx, workspaceID, channelID, userID, capabilities)
		if err != nil {
			return err
		}
		if ac.Channel.ArchivedAt != nil {
			return &DomainError{Code: CodeConflict, Message: "This channel is archived"}
		}
		return fn(tx)
	})
}

// CommitDMParticipant runs fn after the actor is re-checked as a workspace
// member and a participant of this DM. DMs do not use the channel capability
// lock; losing either binding rolls the write back.
func (s *Store) CommitDMParticipant(ctx context.Context, workspaceID, channelID, userID string, fn func(tx Executor) error) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		channel, err := s.getChannel(ctx, tx, channelID, false)
		if err != nil {
			return err
		}
		if channel == nil || channel.WorkspaceID != workspaceID || channel.Type != TypeDM {
			return &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		if channel.ArchivedAt != nil {
			return &DomainError{Code: CodeConflict, Message: "This channel is archived"}
		}
		role, err := s.eligibleHumanRole(ctx, tx, workspaceID, userID)
		if err != nil {
			return err
		}
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
		return fn(tx)
	})
}
