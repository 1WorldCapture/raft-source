package message

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"raft.local/server-go/internal/channel"
)

// This file is the ONLY place that interprets the channel worker's locked
// conversation APIs (docs/m4-channel-worker-report.md §1). Its typed
// channel.DomainError failures are normalized once, here, so the transport
// can render the exact legacy TS bodies per surface.
//
// Frozen semantics (landed internal/channel/conversation.go):
//   - missing workspace membership  -> FORBIDDEN "Not a member of this server"
//   - missing/invisible/cross-space channel, broken parent chain
//     -> NOT_FOUND "Channel not found"
//   - posting without roster membership -> FORBIDDEN "You must join this channel to send messages"
//   - archived channel or root -> CONFLICT "This channel is archived"

// channelExecutor is the executor shape the channel APIs accept; *sql.Tx and
// the pinned snapshot executor both satisfy it.
type channelExecutor = channel.Executor

// ErrNotServerMember maps to the RequireServerScope-style 403.
var ErrNotServerMember = errors.New("Not a member of this server")

// ErrConversationDenied means the base content read was refused (missing or
// invisible conversation, fail-closed indistinguishable). The transport
// renders the legacy deny split with channel.HasPriorChannelRelationshipTx.
var ErrConversationDenied = errors.New("conversation not visible")

// ErrChannelNotFound is the send-surface 404 body "Channel not found".
var ErrChannelNotFound = errors.New("Channel not found")

// normalizeChannelError maps the channel worker's DomainError taxonomy onto
// the message-domain failures. unknownErr=true for infrastructure errors.
func normalizeChannelError(err error) error {
	de := channel.AsDomainError(err)
	if de == nil {
		return err
	}
	switch {
	case de.Message == channel.NotServerMemberMessage:
		return ErrNotServerMember
	case de.Message == "This channel is archived":
		return ErrChannelArchived
	case de.Message == "You must join this channel to send messages":
		return &ErrNotChannelMember{}
	case de.Code == channel.CodeNotFound:
		return ErrConversationDenied
	default:
		return fmt.Errorf("channel authorize: %s", de.Message)
	}
}

// authorizeRead returns the base content authorization for a read path
// (history, context, reaction surfaces). Follow rows never grant this.
func (s *Store) authorizeRead(ctx context.Context, ex channelExecutor, workspaceID, channelID, userID string) (*channel.Conversation, error) {
	conv, err := s.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, userID, false)
	if err != nil {
		return nil, normalizeChannelError(err)
	}
	return conv, nil
}

// authorizePost returns the posting authorization for a write path; refusals
// keep their legacy sentences (403 join-required / 409 archived / 404
// missing). actionName parameterizes the react variant of the sentence.
func (s *Store) authorizePost(ctx context.Context, ex channelExecutor, workspaceID, channelID, userID, actionName string) (*channel.Conversation, error) {
	conv, err := s.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, userID, true)
	if err != nil {
		normalized := normalizeChannelError(err)
		if member, ok := normalized.(*ErrNotChannelMember); ok {
			member.Action = actionName
			return nil, member
		}
		if errors.Is(normalized, ErrConversationDenied) {
			// The send surface distinguishes a missing channel from a
			// membership refusal: posting to an existing-but-unjoined
			// channel already returned FORBIDDEN above, so NOT_FOUND here
			// means the conversation truly is not addressable.
			return nil, ErrChannelNotFound
		}
		return nil, normalized
	}
	return conv, nil
}

// authorizeAgentPost returns the AGENT posting authorization for a write
// path through the channel worker's locked agent conversation API (real
// channel_agents / implicit-membership facts; a human claim is never
// forged). Refusals keep the same legacy sentences the transport renders.
func (s *Store) authorizeAgentPost(ctx context.Context, ex channelExecutor, workspaceID, channelID, agentID string) (*channel.Conversation, error) {
	conv, err := s.channels.AuthorizeAgentConversationTx(ctx, ex, workspaceID, channelID, agentID, true)
	if err != nil {
		normalized := normalizeChannelError(err)
		if member, ok := normalized.(*ErrNotChannelMember); ok {
			member.Action = "send messages"
			return nil, member
		}
		if errors.Is(normalized, ErrConversationDenied) {
			return nil, ErrChannelNotFound
		}
		return nil, normalized
	}
	return conv, nil
}

// authorizeAgentMentionTarget enforces the M5 receipt policy for one typed
// agent mention: the recipient must hold read+reply authority over the
// conversation (posting), so an undeliverable target rejects the whole send
// with the explicit invalid-target sentence instead of a silent drop. A
// denial is a request failure; anything else is infrastructure.
func (s *Store) authorizeAgentMentionTarget(ctx context.Context, ex channelExecutor, workspaceID, channelID, agentID string) error {
	_, err := s.channels.AuthorizeAgentConversationTx(ctx, ex, workspaceID, channelID, agentID, true)
	if err != nil {
		normalized := normalizeChannelError(err)
		switch {
		case errors.Is(normalized, ErrConversationDenied),
			errors.Is(normalized, ErrNotServerMember),
			errors.Is(normalized, ErrChannelNotFound),
			errors.Is(normalized, ErrChannelArchived):
			return &InvalidInput{Reason: "Mention target cannot receive messages in this conversation"}
		default:
			if _, ok := normalized.(*ErrNotChannelMember); ok {
				return &InvalidInput{Reason: "Mention target cannot receive messages in this conversation"}
			}
			return normalized
		}
	}
	return nil
}

// authorizeAgentRead returns the base content authorization for an AGENT
// read path (history/context of the M5 agent surfaces). Follow rows never
// grant this.
func (s *Store) authorizeAgentRead(ctx context.Context, ex channelExecutor, workspaceID, channelID, agentID string) (*channel.Conversation, error) {
	conv, err := s.channels.AuthorizeAgentConversationTx(ctx, ex, workspaceID, channelID, agentID, false)
	if err != nil {
		return nil, normalizeChannelError(err)
	}
	return conv, nil
}

// syncAudience reports whether channelID belongs in this user's message
// stream: base content read PLUS the active thread-follow interest. Only
// sync/resume consult this; history/context never do.
func (s *Store) syncAudience(ctx context.Context, ex channelExecutor, workspaceID, channelID, userID string) (bool, error) {
	ok, err := s.channels.SelectSyncAudienceTx(ctx, ex, workspaceID, channelID, userID)
	if err != nil {
		return false, normalizeChannelError(err)
	}
	return ok, nil
}

// setThreadFollow records the automatic reply/mention thread follow through
// the channel worker's owned mutation. Never a direct thread_follows write.
func (s *Store) setThreadFollow(ctx context.Context, tx *sql.Tx, workspaceID, threadID, userID string) error {
	if err := s.channels.SetThreadFollowTx(ctx, tx, workspaceID, threadID, userID, true, true); err != nil {
		return fmt.Errorf("thread follow: %w", err)
	}
	return nil
}

// hasPriorRelationship backs the legacy 403/404 deny split without leaking
// existence to strangers.
func (s *Store) hasPriorRelationship(ctx context.Context, ex channelExecutor, userID, channelID string) (bool, error) {
	return s.channels.HasPriorChannelRelationshipTx(ctx, ex, userID, channelID)
}
