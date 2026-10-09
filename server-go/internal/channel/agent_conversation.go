// M5 Agent conversation authorization: the fail-closed content policy for one
// AGENT viewer over one conversation, porting the original TS
// canAgentAccessChannel / canAgentPostToChannel decision (agentProcessManager's
// server side). Only real agent/workspace/conversation facts are consulted —
// no human claim is ever forged. Threads inherit their root's policy; DMs are
// exactly their participant rows; enabled system channels follow the existing
// agent-directory implicit-membership rule; guests/hidden #all/archived and
// deleted channels never open up.
package channel

import (
	"context"
	"database/sql"
	"fmt"
)

// liveAgentRole resolves the agent's real liveness and its additive
// agent_members role inside the caller's transaction. ok=false means the
// agent is not a live member of THIS workspace (missing row, soft-deleted
// agent, or a deleted/joint-storage workspace) and every conversation
// question fail-closes.
func (s *Store) liveAgentRole(ctx context.Context, ex Executor, workspaceID, agentID string) (role string, ok bool, err error) {
	err = ex.QueryRowContext(ctx, `
		SELECT COALESCE(am.role, '')
		FROM agents a
		JOIN workspaces w ON w.id = a.workspace_id
		LEFT JOIN agent_members am ON am.workspace_id = a.workspace_id AND am.agent_id = a.id
		WHERE a.id = ? AND a.workspace_id = ?
		  AND a.deleted_at IS NULL AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
		agentID, workspaceID).Scan(&role)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read live agent: %w", err)
	}
	return role, true, nil
}

// isChannelAgentTx answers whether the agent holds a channel_agents roster
// row on one channel (the DM participant fact for agent DMs).
func (s *Store) isChannelAgentTx(ctx context.Context, ex Executor, channelID, agentID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx,
		`SELECT 1 FROM channel_agents WHERE channel_id = ? AND agent_id = ?`, channelID, agentID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read channel_agents: %w", err)
	}
	return true, nil
}

// AuthorizeAgentConversationTx resolves the base content policy for one
// AGENT viewer. posting=false answers "may the agent read the content"
// (public channels stay readable); posting=true additionally enforces the
// agent posting policy — implicit-membership system channels admit every
// live workspace agent (original isServerAgent), every other root requires
// a real channel_agents roster row, threads inherit the root, and an
// archived channel or root refuses with the legacy conflict sentence.
//
// Failure modes reuse the human conversation taxonomy so callers map them
// with the same channel.DomainError handling:
//   - agent not a live member of the workspace → FORBIDDEN NotServerMemberMessage
//   - missing/invisible/cross-space channel or broken thread chain
//     → NOT_FOUND "Channel not found"
//   - posting without the required roster      → FORBIDDEN postJoinRequiredMessage
//   - archived channel or root                 → CONFLICT "This channel is archived"
func (s *Store) AuthorizeAgentConversationTx(ctx context.Context, ex Executor, workspaceID, channelID, agentID string, posting bool) (*Conversation, error) {
	role, ok, err := s.liveAgentRole(ctx, ex, workspaceID, agentID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
	}

	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return nil, err
	}
	if channel == nil || channel.WorkspaceID != workspaceID {
		return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}

	// Threads inherit both read and post policy from the root conversation
	// (same parent-chain walk and cycle bound as the human path).
	root := channel
	parentMessageID := ""
	visited := map[string]bool{channel.ID: true}
	for root.Type == TypeThread {
		if root.ParentMessageID == nil || *root.ParentMessageID == "" {
			return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		if parentMessageID == "" {
			parentMessageID = *root.ParentMessageID
		}
		parentChannel, err := s.threadRootChannel(ctx, ex, workspaceID, *root.ParentMessageID)
		if err != nil {
			return nil, err
		}
		if parentChannel == nil || parentChannel.Type == TypeThread || visited[parentChannel.ID] {
			return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		if len(visited) >= ThreadChainDepthLimit {
			return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		visited[parentChannel.ID] = true
		root = parentChannel
	}

	member, err := s.isChannelAgentTx(ctx, ex, root.ID, agentID)
	if err != nil {
		return nil, err
	}

	if posting {
		if !canAgentPostRoot(root, member) {
			return nil, &DomainError{Code: CodeForbidden, Message: postJoinRequiredMessage}
		}
		if channel.ArchivedAt != nil || root.ArchivedAt != nil {
			return nil, &DomainError{Code: CodeConflict, Message: "This channel is archived"}
		}
	} else if !canAgentReadRoot(root, member) {
		return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}

	return &Conversation{
		Channel:         channel,
		Root:            root,
		ParentMessageID: parentMessageID,
		Role:            role,
		IsMember:        member,
	}, nil
}

// canAgentReadRoot ports canAgentAccessChannel for one root channel: a
// hidden #all never opens; ordinary public channels are readable by every
// live workspace agent; private/joint/DM stay roster-only (the DM roster row
// IS the participant fact for agent DMs).
func canAgentReadRoot(root *Channel, member bool) bool {
	if IsAllSystemChannel(root) && !IsEnabledAllChannel(root) {
		return false
	}
	switch root.Type {
	case TypeChannel:
		return true
	case TypePrivate, TypeJoint, TypeDM:
		return member
	default:
		return false
	}
}

// canAgentPostRoot ports canAgentPostToChannel: implicit-membership system
// channels (the enabled #all and #announcement) admit every live workspace
// agent — the caller has already established live agent membership, exactly
// like the original isServerAgent; every other root requires the explicit
// channel_agents roster. The frozen joint slice is treated like private
// (roster only), never broader.
func canAgentPostRoot(root *Channel, member bool) bool {
	if IsAllSystemChannel(root) && !IsEnabledAllChannel(root) {
		return false
	}
	if HasImplicitServerMembership(root) {
		return true
	}
	return member
}

// AgentDMParticipantTx resolves the agent participant of the canonical
// human-Agent DM rooted at channelID through the typed pair fact. ok=false
// means this channel is not a persisted human-Agent DM (ordinary human DM,
// thread, or unknown channel) and no implicit receipt may be planned.
func (s *Store) AgentDMParticipantTx(ctx context.Context, ex Executor, workspaceID, channelID string) (string, bool, error) {
	var agentID string
	err := ex.QueryRowContext(ctx, `
		SELECT adm.agent_id FROM agent_direct_messages adm
		JOIN channels c ON c.id = adm.channel_id
		WHERE adm.workspace_id = ? AND adm.channel_id = ?
		  AND c.workspace_id = adm.workspace_id AND c.type = ? AND c.deleted_at IS NULL`,
		workspaceID, channelID, TypeDM).Scan(&agentID)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read agent dm participant: %w", err)
	}
	return agentID, true, nil
}
