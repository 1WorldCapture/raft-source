package messaging

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
)

// DMRow is one DM list/create row: the channel peer projection plus the
// readstate-owned #632 frontier facts (nil = omit the field, the older
// server tolerance).
type DMRow struct {
	View      channel.DMView
	ReadState *readstate.ReadFrontier
}

// ListDMs assembles the DM list on one pinned snapshot: conversation rows
// and viewer frontiers share one pinned view; a later naked DB read could
// mix membership/read-state generations.
func (s *Service) ListDMs(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor string) ([]DMRow, error) {
	if actor != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var out []DMRow
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(ctx, ex, claims, now()); err != nil {
			return err
		}
		views, err := s.channels.ListDMsTx(ctx, ex, workspaceID, actor)
		if err != nil {
			return err
		}
		out = make([]DMRow, 0, len(views))
		for _, v := range views {
			readState, err := s.dmReadState(ctx, ex, workspaceID, actor, v.Channel.ID)
			if err != nil {
				return err
			}
			out = append(out, DMRow{View: v, ReadState: readState})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// CreateDM ensures the DM with the target human (or the caller's self-DM).
// The {agentId} branch validates the target then refuses with the honest
// 501 before any mutation; the hidden human directory reads unknown targets
// as absent unless an existing conversation still resolves.
func (s *Service) CreateDM(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, actor, targetUserID, agentID string, agentBranch, userBranch bool) (*DMRow, error) {
	if actor != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var result *DMRow
	err := platformdb.WithWriteTx(ctx, s.channels.DB(), func(tx *sql.Tx) error {
		if err := auth.ValidateHumanTx(ctx, tx, claims, now()); err != nil {
			return err
		}
		if agentBranch {
			// Shape and identity are validated; verify the target exists in
			// this workspace, then refuse honestly without creating anything.
			exists, err := s.channels.AgentExistsInWorkspace(ctx, tx, agentID, workspaceID)
			if err != nil {
				return err
			}
			if !exists {
				return ErrAgentDMTargetNotFound
			}
			return ErrAgentDMNotImplemented
		}
		targetID := targetUserID
		// Hidden human directory: unknown targets read as absent, but an
		// existing conversation still resolves (route order).
		if targetID != actor {
			hidden, err := s.channels.ShouldHideHumanDirectoryTx(ctx, tx, workspaceID, actor)
			if err != nil {
				return err
			}
			if hidden {
				existing, err := s.channels.LookupDMTx(ctx, tx, workspaceID, actor, targetID)
				if err != nil {
					return err
				}
				if existing == nil {
					return ErrDMTargetNotFound
				}
			}
		}
		channelRow, err := s.channels.EnsureDMTx(ctx, tx, workspaceID, actor, targetID)
		if err != nil {
			return err
		}
		// dm:new intents for real creation/revive are emitted by EnsureDMTx
		// (transition-keyed revisions) on this same transaction.
		view, err := s.dmViewFor(ctx, tx, workspaceID, actor, channelRow.ID)
		if err != nil {
			return err
		}
		readState, err := s.dmReadState(ctx, tx, workspaceID, actor, view.Channel.ID)
		if err != nil {
			return err
		}
		result = &DMRow{View: *view, ReadState: readState}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// dmViewFor resolves the peer projection of one DM channel inside the
// caller's transaction (listDMChannels' single-row shape).
func (s *Service) dmViewFor(ctx context.Context, ex channel.Executor, workspaceID, actor, channelID string) (*channel.DMView, error) {
	views, err := s.channels.ListDMsTx(ctx, ex, workspaceID, actor)
	if err != nil {
		return nil, err
	}
	for _, v := range views {
		if v.Channel.ID == channelID {
			view := v
			return &view, nil
		}
	}
	return nil, errors.New("dm channel missing from own list")
}

// PriorChannelRelationship reports whether the user ever had a relationship
// with the channel (the legacy 403/404 deny split). It reads on one pinned
// snapshot through the channel-owned fact API.
func (s *Service) PriorChannelRelationship(ctx context.Context, userID, channelID string) (bool, error) {
	var prior bool
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		ok, err := s.channels.HasPriorChannelRelationshipTx(ctx, ex, userID, channelID)
		if err != nil {
			return err
		}
		prior = ok
		return nil
	})
	if err != nil {
		return false, err
	}
	return prior, nil
}
