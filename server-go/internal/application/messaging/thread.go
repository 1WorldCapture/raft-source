package messaging

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

// Sentinel outcomes the HTTP adapter maps to their frozen statuses/bodies.
var (
	// ErrChannelMissingOrForeign: the addressed channel does not exist or
	// belongs to another workspace (the exits answer the byte-stable 404).
	ErrChannelMissingOrForeign = errors.New("channel missing or foreign")
	// ErrAgentDMTargetNotFound: the {agentId} branch's 404 when the agent is
	// not a live member of the workspace.
	ErrAgentDMTargetNotFound = errors.New("agent dm target missing")
	// ErrAgentDMNotImplemented is retained so existing HTTP adapters keep
	// compiling. CreateDM no longer returns it: a live workspace agent opens
	// the canonical human-Agent DM.
	ErrAgentDMNotImplemented = errors.New("agent dm not implemented")
	// ErrDMTargetNotFound: the hidden-directory 404.
	ErrDMTargetNotFound = errors.New("dm target missing")
	// ErrThreadNotFound: unfollow of a missing/invisible thread.
	ErrThreadNotFound = errors.New("thread not found")
)

// AccessDenied wraps a base-content authorization denial (kept for the
// 403/404 prior-relationship split in the adapter).
type AccessDenied struct{ Cause error }

func (e *AccessDenied) Error() string { return "channel access denied" }
func (e *AccessDenied) Unwrap() error { return e.Cause }

// ChannelMissing is the sentinel for the CreateThread preconditions.
type ChannelMissing struct{}

func (ChannelMissing) Error() string { return "channel missing or foreign" }

// CreateThreadResult carries the thread info plus the ensured thread id.
type CreateThreadResult struct {
	ThreadID string
	Info     *channel.ThreadInfo
}

// CreateThread ensures the unique thread of one parent message and
// optionally posts the first reply in the SAME transaction (the reply runs
// through the same in-transaction send step; no nested complete use case).
func (s *Service) CreateThread(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor, channelID, parentMessageID string, wantsReply bool, content string) (*CreateThreadResult, error) {
	if actor != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var result *CreateThreadResult
	err := platformdb.WithWriteTx(ctx, s.channels.DB(), func(tx *sql.Tx) error {
		if err := auth.ValidateHumanTx(ctx, tx, claims, time.Now()); err != nil {
			return err
		}
		channelRow, err := s.channels.GetChannelTx(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if channelRow == nil || channelRow.WorkspaceID != workspaceID {
			return ErrChannelMissingOrForeign
		}
		if _, err := s.channels.AuthorizeConversationTx(ctx, tx, workspaceID, channelID, actor, false); err != nil {
			return &AccessDenied{Cause: err}
		}
		if channelRow.Type == channel.TypeThread {
			return &channel.DomainError{Code: channel.CodeInvalidInput, Message: channel.ThreadNestedMessage}
		}
		if channelRow.ArchivedAt != nil {
			return &channel.DomainError{Code: channel.CodeConflict, Message: "This channel is archived"}
		}
		thread, err := s.channels.EnsureThreadTx(ctx, tx, workspaceID, channelID, parentMessageID, actor)
		if err != nil {
			return err
		}
		// messages.thread_id has exactly one writer: the message-owned
		// attach primitive, orchestrated here in the same commit as the
		// channel's ensure and author follow.
		if err := s.messages.AttachThreadToParentTx(ctx, tx, parentMessageID, thread.ID); err != nil {
			return err
		}
		// The thread:updated appearance intent is emitted by EnsureThreadTx on
		// real creation only; re-ensures stay silent.
		if wantsReply {
			if _, err := s.sendHumanTx(ctx, tx, claims, workspaceID, sendInput(thread.ID, content)); err != nil {
				return err
			}
		}
		info, err := s.channels.ThreadInfoTx(ctx, tx, channelID, parentMessageID)
		if err != nil {
			return err
		}
		if info == nil {
			return errors.New("thread missing immediately after ensure")
		}
		result = &CreateThreadResult{ThreadID: thread.ID, Info: info}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// ThreadSummaries handles the summary read model on one pinned snapshot
// (parentIDs nil selects the legacy bounded recent-parent window).
func (s *Service) ThreadSummaries(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor, channelID string, parentIDs []string) (map[string]channel.ThreadSummary, error) {
	if actor != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var summaries map[string]channel.ThreadSummary
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		channelRow, err := s.channels.GetChannelTx(ctx, ex, channelID)
		if err != nil {
			return err
		}
		if channelRow == nil || channelRow.WorkspaceID != workspaceID {
			return ErrChannelMissingOrForeign
		}
		if err := auth.ValidateHumanTx(ctx, ex, claims, time.Now()); err != nil {
			return err
		}
		if _, err := s.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, actor, false); err != nil {
			return &AccessDenied{Cause: err}
		}
		if parentIDs == nil {
			// Legacy no-parameter compatibility: bounded recent-parent window.
			recent, err := s.channels.RecentThreadParentIDsTx(ctx, ex, channelID, channel.ThreadSummaryCompatParentsLimit)
			if err != nil {
				return err
			}
			parentIDs = recent
		}
		summaries, err = s.channels.ThreadSummariesTx(ctx, ex, workspaceID, channelID, parentIDs, actor, s.readCursor)
		return err
	})
	if err != nil {
		return nil, err
	}
	return summaries, nil
}

// ThreadInfo reads one parent message's thread info on one pinned snapshot;
// nil means no thread exists for the message.
func (s *Service) ThreadInfo(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor, channelID, parentMessageID string) (*channel.ThreadInfo, error) {
	if actor != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var info *channel.ThreadInfo
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		channelRow, err := s.channels.GetChannelTx(ctx, ex, channelID)
		if err != nil {
			return err
		}
		if channelRow == nil || channelRow.WorkspaceID != workspaceID {
			return ErrChannelMissingOrForeign
		}
		if err := auth.ValidateHumanTx(ctx, ex, claims, time.Now()); err != nil {
			return err
		}
		if _, err := s.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, actor, false); err != nil {
			return &AccessDenied{Cause: err}
		}
		info, err = s.channels.ThreadInfoTx(ctx, ex, channelID, parentMessageID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return info, nil
}

// FollowedThreads lists the actor's followed threads on one pinned snapshot.
func (s *Service) FollowedThreads(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor string) ([]channel.FollowedThread, error) {
	if actor != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var threads []channel.FollowedThread
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(ctx, ex, claims, time.Now()); err != nil {
			return err
		}
		var err error
		threads, err = s.channels.FollowedThreadsTx(ctx, ex, workspaceID, actor, s.readCursor)
		return err
	})
	if err != nil {
		return nil, err
	}
	return threads, nil
}

// FollowThread is the explicit manual follow: authorize the parent message,
// ensure the thread, record the follow (reactivating an unfollowed row) and
// advance the follower's own read boundary inside the SAME transaction —
// exactly the original followThread pairing. The followers-updated intent is
// emitted by the owning domain mutation.
func (s *Service) FollowThread(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor, parentMessageID string) (string, error) {
	if actor != claims.Subject {
		return "", auth.ErrTokenInvalid
	}
	threadChannelID := ""
	err := platformdb.WithWriteTx(ctx, s.channels.DB(), func(tx *sql.Tx) error {
		if err := auth.ValidateHumanTx(ctx, tx, claims, time.Now()); err != nil {
			return err
		}
		parent, err := s.channels.AuthorizeParentMessageTx(ctx, tx, workspaceID, parentMessageID, actor)
		if err != nil {
			return err
		}
		thread, err := s.channels.EnsureThreadTx(ctx, tx, workspaceID, parent.ID, parentMessageID, actor)
		if err != nil {
			return err
		}
		if err := s.messages.AttachThreadToParentTx(ctx, tx, parentMessageID, thread.ID); err != nil {
			return err
		}
		if err := s.channels.SetThreadFollowTx(ctx, tx, workspaceID, thread.ID, actor, true, false); err != nil {
			return err
		}
		if _, err := s.readstate.MarkReadLatestTx(ctx, tx, claims, workspaceID, thread.ID); err != nil {
			return err
		}
		threadChannelID = thread.ID
		return nil
	})
	if err != nil {
		return "", err
	}
	return threadChannelID, nil
}

// UnfollowThread records the explicit unfollow; the row is kept as history
// and content access is not revoked by losing interest.
func (s *Service) UnfollowThread(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor, threadChannelID string) error {
	if actor != claims.Subject {
		return auth.ErrTokenInvalid
	}
	return platformdb.WithWriteTx(ctx, s.channels.DB(), func(tx *sql.Tx) error {
		if err := auth.ValidateHumanTx(ctx, tx, claims, time.Now()); err != nil {
			return err
		}
		channelRow, err := s.channels.GetChannelTx(ctx, tx, threadChannelID)
		if err != nil {
			return err
		}
		if channelRow == nil || channelRow.WorkspaceID != workspaceID || channelRow.Type != channel.TypeThread {
			return ErrThreadNotFound
		}
		if _, err := s.channels.AuthorizeConversationTx(ctx, tx, workspaceID, threadChannelID, actor, false); err != nil {
			return ErrThreadNotFound
		}
		return s.channels.SetThreadFollowTx(ctx, tx, workspaceID, threadChannelID, actor, false, false)
	})
}
