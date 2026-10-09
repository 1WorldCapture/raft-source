// Canonical human-Agent direct messages (M5): the typed pair fact lives in
// its own agent_direct_messages table (migration 0014, delivery-owned DDL,
// channel-owned writes) — an Agent UUID never enters the human
// direct_messages pair table. Creation converges on one channel per
// (workspace, user, agent), revives soft-deleted rows like the human ensure,
// and emits the dm:new intent only on real transitions.
package channel

import (
	"context"
	"database/sql"
	"fmt"
)

// AgentDMTargetNotMemberMessage is the agent-target refusal of the ensure
// (the application maps it to the route's 404).
const AgentDMTargetNotMemberMessage = "Agent is not a member of this server"

// agentDMName resolves the channel name for a human-Agent DM (the agent's
// directory handle, "Agent" fallback).
func (s *Store) agentDMName(ctx context.Context, ex Executor, agentID string) (string, error) {
	var name string
	err := ex.QueryRowContext(ctx,
		`SELECT name FROM agents WHERE id = ?`, agentID).Scan(&name)
	if err == sql.ErrNoRows {
		return "Agent", nil
	}
	if err != nil {
		return "", fmt.Errorf("read agent name: %w", err)
	}
	if name == "" {
		return "Agent", nil
	}
	return name, nil
}

// EnsureAgentDMTx finds or creates the canonical DM conversation of one
// human and one agent in the caller's transaction. Existing typed pairs
// return the same channel even when a participant is no longer eligible (a
// soft-deleted row is restored, mirroring the human ensure); new pairs
// require a non-guest eligible human and a live workspace agent. The roster
// rows (channel_humans for the human, channel_agents for the agent) are the
// only admission facts — no third party can join or read.
func (s *Store) EnsureAgentDMTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, agentID string) (*Channel, error) {
	role, err := s.eligibleHumanRole(ctx, tx, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
	}
	if role == RoleGuest {
		return nil, &DomainError{Code: CodeForbidden, Message: DMGuestCreateMessage}
	}
	if _, live, err := s.liveAgentRole(ctx, tx, workspaceID, agentID); err != nil {
		return nil, err
	} else if !live {
		return nil, &DomainError{Code: CodeInvalidInput, Message: AgentDMTargetNotMemberMessage}
	}

	existing, revived, err := s.readAgentDMChannel(ctx, tx, workspaceID, userID, agentID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if revived {
			if err := s.enqueueDMNew(ctx, tx, workspaceID, existing.ID); err != nil {
				return nil, err
			}
		}
		return existing, nil
	}

	name, err := s.agentDMName(ctx, tx, agentID)
	if err != nil {
		return nil, err
	}
	id, err := newUUID()
	if err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, workspaceID, name, TypeDM, now); err != nil {
		return nil, fmt.Errorf("insert agent dm channel: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, id, userID, now); err != nil {
		return nil, fmt.Errorf("insert agent dm roster (human): %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channel_agents (channel_id, agent_id, role, authority_revision, added_at)
		VALUES (?, ?, 'member', 1, ?)`, id, agentID, now); err != nil {
		return nil, fmt.Errorf("insert agent dm roster (agent): %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO agent_direct_messages (workspace_id, user_id, agent_id, channel_id, created_at)
		VALUES (?, ?, ?, ?, ?)`, workspaceID, userID, agentID, id, now); err != nil {
		if isUniqueViolation(err) {
			// A concurrent ensure of the same pair won; converge on its
			// channel exactly like the human path.
			winner, winnerRevived, readErr := s.readAgentDMChannel(ctx, tx, workspaceID, userID, agentID)
			if readErr == nil && winner != nil {
				if winnerRevived {
					if err := s.enqueueDMNew(ctx, tx, workspaceID, winner.ID); err != nil {
						return nil, err
					}
				}
				return winner, nil
			}
		}
		return nil, fmt.Errorf("insert agent_direct_messages: %w", err)
	}
	if err := s.enqueueDMNew(ctx, tx, workspaceID, id); err != nil {
		return nil, err
	}
	return s.getChannel(ctx, tx, id, false)
}

// readAgentDMChannel resolves the channel of an existing typed pair,
// restoring a soft-deleted row like the human ensure. revived reports a real
// restore (a dm:new transition); nil without error means no conversation
// exists for the pair yet.
func (s *Store) readAgentDMChannel(ctx context.Context, ex Executor, workspaceID, userID, agentID string) (*Channel, bool, error) {
	var channelID string
	err := ex.QueryRowContext(ctx,
		`SELECT channel_id FROM agent_direct_messages
		 WHERE workspace_id = ? AND user_id = ? AND agent_id = ?`,
		workspaceID, userID, agentID).Scan(&channelID)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read agent_direct_messages pair: %w", err)
	}
	channel, err := s.getChannel(ctx, ex, channelID, true)
	if err != nil {
		return nil, false, err
	}
	if channel == nil {
		return nil, false, fmt.Errorf("agent dm pair %s/%s references missing channel %s", userID, agentID, channelID)
	}
	if channel.DeletedAt != nil {
		if _, err := ex.ExecContext(ctx,
			`UPDATE channels SET deleted_at = NULL WHERE id = ?`, channelID); err != nil {
			return nil, false, fmt.Errorf("restore soft-deleted agent dm: %w", err)
		}
		channel.DeletedAt = nil
		return channel, true, nil
	}
	return channel, false, nil
}

// agentDMListColumns extends the channel row with the AGENT peer identity
// and the last-message timestamp of the human's agent-DM rows.
const agentDMListColumns = channelColumns + `,
	a.id, a.name, a.display_name, a.description, a.avatar_url,
	(SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id)`

// scanAgentDMView scans one agentDMListColumns row into a DMView whose
// PeerType is the honest "agent" (no gravatar — agents carry no email).
func scanAgentDMView(scanner interface{ Scan(dest ...any) error }) (*DMView, error) {
	var v DMView
	var description, systemKind, parentMessage, archivedByUser, archivedByAgent sql.NullString
	var peerDisplayName, peerDescription, peerAvatar sql.NullString
	var archivedAt, deletedAt, lastMessageAt sql.NullInt64
	var guestVisible, guestJoinable int
	var createdAt int64
	if err := scanner.Scan(&v.Channel.ID, &v.Channel.WorkspaceID, &v.Channel.Name, &description, &v.Channel.Type, &systemKind,
		&guestVisible, &guestJoinable, &parentMessage, &createdAt,
		&archivedAt, &archivedByUser, &archivedByAgent, &deletedAt,
		&v.PeerID, &v.PeerName, &peerDisplayName, &peerDescription, &peerAvatar,
		&lastMessageAt); err != nil {
		return nil, err
	}
	applyChannelNulls(&v.Channel, description, systemKind, parentMessage, archivedByUser, archivedByAgent,
		guestVisible, guestJoinable, createdAt, archivedAt, deletedAt)
	if peerDisplayName.Valid {
		v.PeerDisplayName = &peerDisplayName.String
	}
	if peerDescription.Valid {
		v.PeerDescription = &peerDescription.String
	}
	if peerAvatar.Valid {
		v.PeerAvatarURL = &peerAvatar.String
	}
	v.PeerType = "agent"
	if lastMessageAt.Valid {
		millis := lastMessageAt.Int64
		v.LastMessageAt = &millis
	}
	return &v, nil
}

// listAgentDMsTx returns the human's canonical human-Agent DM rows on the
// caller's executor (typed pair fact as the load-bearing filter; the peer
// projection comes from the agents table, never users).
func (s *Store) listAgentDMsTx(ctx context.Context, ex Executor, workspaceID, userID string) ([]DMView, error) {
	rows, err := ex.QueryContext(ctx, `
		SELECT `+agentDMListColumns+`
		FROM agent_direct_messages adm
		JOIN channels c
		  ON c.id = adm.channel_id
		 AND c.workspace_id = adm.workspace_id
		 AND c.type = 'dm'
		 AND c.deleted_at IS NULL
		JOIN agents a ON a.id = adm.agent_id
		WHERE adm.workspace_id = ? AND adm.user_id = ?
		ORDER BY c.id`, workspaceID, userID)
	if err != nil {
		return nil, fmt.Errorf("list agent dms: %w", err)
	}
	defer rows.Close()
	views := []DMView{}
	for rows.Next() {
		v, err := scanAgentDMView(rows)
		if err != nil {
			return nil, err
		}
		views = append(views, *v)
	}
	return views, rows.Err()
}

// ListDMsWithAgentsTx is the unified human DM list of the M5 slice: the
// human-human rows of ListDMsTx plus the human-Agent rows, each carrying its
// true PeerType. Ordering matches the legacy rule (most recent message
// first, creation order for empty conversations). The existing ListDMsTx
// stays byte-stable for the current transport until the parent wires this
// unified projection and passes PeerType through.
func (s *Store) ListDMsWithAgentsTx(ctx context.Context, ex Executor, workspaceID, userID string) ([]DMView, error) {
	human, err := s.ListDMsTx(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	for i := range human {
		human[i].PeerType = "user"
	}
	agent, err := s.listAgentDMsTx(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	views := append(human, agent...)
	sortDMViewsByLastMessage(views)
	return views, nil
}

// ResolveAgentDMByPeerNameTx resolves the EXISTING canonical DM between the
// acting agent and one human peer handle (target DSL dm:@peer). It never
// creates or revives anything; nil means no such conversation. Peer names
// outside this workspace do not resolve.
func (s *Store) ResolveAgentDMByPeerNameTx(ctx context.Context, ex Executor, workspaceID, agentID, peerName string) (*Channel, error) {
	if peerName == "" {
		return nil, nil
	}
	var channelID string
	err := ex.QueryRowContext(ctx, `
		SELECT adm.channel_id
		FROM agent_direct_messages adm
		JOIN users u ON u.id = adm.user_id
		JOIN channels c ON c.id = adm.channel_id
		WHERE adm.workspace_id = ? AND adm.agent_id = ? AND u.name = ?
		  AND c.deleted_at IS NULL`,
		workspaceID, agentID, peerName).Scan(&channelID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve agent dm by peer name: %w", err)
	}
	return s.getChannel(ctx, ex, channelID, false)
}
