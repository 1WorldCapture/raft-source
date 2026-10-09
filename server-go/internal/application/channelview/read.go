package channelview

import (
	"context"
	"errors"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	platformdb "raft.local/server-go/internal/platform/db"
)

var errMissingDependency = errors.New("channelview: channels, readstate and messages fact owners are required")

// ErrNotFound reports a channel that is missing, deleted, foreign to the
// acting workspace, or not visible to the viewer (the legacy exits answer
// all four with the same 404 body).
var ErrNotFound = errors.New("channel not found or not visible")

// ListRow is one list-exit fact bundle: the channel row, its joined flag and
// the viewer-private projection.
type ListRow struct {
	Channel    channel.Channel
	Joined     bool
	ActorCtx   *channel.ActorContext
	Projection Projection
}

// DetailRow is the detail-exit fact bundle (adds the derived joined flag).
type DetailRow struct {
	Channel    channel.Channel
	Joined     bool
	ActorCtx   *channel.ActorContext
	Projection Projection
}

// CreateRow is the create-exit fact bundle read on one snapshot AFTER the
// channel fact committed.
type CreateRow struct {
	Channel    channel.Channel
	ActorCtx   *channel.ActorContext
	Projection Projection
}

// List assembles the list exit on ONE pinned read snapshot: verified human
// revalidation, the channel authority rows, per-row actor context and the
// viewer-private projection all share the snapshot.
func (s *Service) List(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, userID, archivedFilter string) ([]ListRow, error) {
	if userID != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var rows []ListRow
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(ctx, ex, claims, time.Now()); err != nil {
			return err
		}
		items, err := s.channels.ListChannelsTx(ctx, ex, workspaceID, userID, archivedFilter)
		if err != nil {
			return err
		}
		channelRows := make([]channel.Channel, 0, len(items))
		for _, item := range items {
			channelRows = append(channelRows, item.Channel)
		}
		projections, err := s.Project(ctx, ex, workspaceID, userID, channelRows, true)
		if err != nil {
			return err
		}
		rows = make([]ListRow, 0, len(items))
		for _, item := range items {
			ac, err := s.channels.ResolveChannelActorContextTx(ctx, ex, item.Channel.WorkspaceID, item.Channel.ID, "user", userID)
			if err != nil {
				return err
			}
			rows = append(rows, ListRow{
				Channel: item.Channel, Joined: item.Joined, ActorCtx: ac,
				Projection: projections[item.Channel.ID],
			})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// Detail assembles the detail exit for one channel on ONE pinned read
// snapshot; ErrNotFound covers missing/foreign/invisible channels.
func (s *Service) Detail(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, userID, channelID string) (*DetailRow, error) {
	if userID != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var row *DetailRow
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(ctx, ex, claims, time.Now()); err != nil {
			return err
		}
		c, err := s.channels.GetChannelTx(ctx, ex, channelID)
		if err != nil {
			return err
		}
		if c == nil || c.WorkspaceID != workspaceID {
			return ErrNotFound
		}
		visible, err := s.channels.CanUserAccessChannelTx(ctx, ex, workspaceID, c.ID, userID)
		if err != nil {
			return err
		}
		if !visible {
			return ErrNotFound
		}
		joined, err := s.Joined(ctx, ex, c, userID)
		if err != nil {
			return err
		}
		ac, err := s.channels.ResolveChannelActorContextTx(ctx, ex, c.WorkspaceID, c.ID, "user", userID)
		if err != nil {
			return err
		}
		projections, err := s.Project(ctx, ex, workspaceID, userID, []channel.Channel{*c}, false)
		if err != nil {
			return err
		}
		row = &DetailRow{Channel: *c, Joined: joined, ActorCtx: ac, Projection: projections[c.ID]}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return row, nil
}

// CreateResult reads the freshly created channel's (legitimately empty)
// viewer state on one snapshot through the same projector as the other
// exits, so the response states fresh-scope facts instead of an old scope's
// defaults.
func (s *Service) CreateResult(ctx context.Context, claims auth.AccessTokenClaims, workspaceID, userID string, created channel.Channel) (*CreateRow, error) {
	if userID != claims.Subject {
		return nil, auth.ErrTokenInvalid
	}
	var row *CreateRow
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		if err := auth.ValidateHumanTx(ctx, ex, claims, time.Now()); err != nil {
			return err
		}
		ac, err := s.channels.ResolveChannelActorContextTx(ctx, ex, workspaceID, created.ID, "user", userID)
		if err != nil {
			return err
		}
		projections, err := s.Project(ctx, ex, workspaceID, userID, []channel.Channel{created}, false)
		if err != nil {
			return err
		}
		row = &CreateRow{Channel: created, ActorCtx: ac, Projection: projections[created.ID]}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return row, nil
}

// Joined derives the detail exit's joined flag on the pinned executor (DM
// and implicit-membership channels read joined; the hidden #all never does
// for guests).
func (s *Service) Joined(ctx context.Context, ex channel.Executor, c *channel.Channel, actor string) (bool, error) {
	if c.Type == channel.TypeDM {
		return true, nil
	}
	serverRole, err := s.channels.HumanServerRoleTx(ctx, ex, c.WorkspaceID, actor)
	if err != nil {
		return false, err
	}
	if serverRole != channel.RoleGuest && channel.HasImplicitServerMembership(c) {
		return true, nil
	}
	if channel.IsAllSystemChannel(c) && serverRole == channel.RoleGuest {
		return false, nil
	}
	return s.channels.IsChannelHumanTx(ctx, ex, c.ID, actor)
}
