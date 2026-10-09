package realtime

// Channel state / roster events. The channel worker records durable
// references on the SAME transaction as the fact (internal/channel/
// publications.go): object_type "channel", object_id = scope_id = the
// channel id, revision strictly increasing per (workspace, channel, event)
// key. Intent rows carry no payload; everything below is reprojected from
// CURRENT facts under the authority-serial binding, exactly like the TS
// publishChannelUpdate / emitChannelMembersUpdated behaviors
// (channelRealtimeEvents.ts, channels.ts:385-402).

import (
	"context"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/publication"
)

// channelEventFacts is one snapshot's worth of channel-event truth: the
// current channel row plus both policy audiences the two event families
// need. exists=false covers missing, deleted and cross-workspace channels:
// the dispatcher completes the intent without a delivery (deletion itself is
// fail-closed on the authority side and never rides these notifications).
type channelEventFacts struct {
	Channel    *channel.Channel
	Serial     uint64
	Live       map[string]struct{}
	ServerRoom map[string]struct{}
	Members    map[string]struct{}
}

func (d *Dispatcher) resolveChannelEventFacts(ctx context.Context, workspaceID, channelID string) (channelEventFacts, bool, error) {
	serial0 := d.serial()
	out := channelEventFacts{Serial: serial0, Live: map[string]struct{}{}, ServerRoom: map[string]struct{}{}, Members: map[string]struct{}{}}
	exists := false
	err := db.WithReadSnapshot(ctx, d.db, func(ex db.Executor) error {
		ch, err := d.channels.GetChannelTx(ctx, ex, channelID)
		if err != nil {
			return err
		}
		if ch == nil || ch.WorkspaceID != workspaceID {
			return nil // gone, deleted or a foreign workspace: complete silently
		}
		exists = true
		out.Channel = ch
		if err := channelRosterInto(ctx, out.Members, ex, workspaceID, channelID); err != nil {
			return err
		}

		members := func() error { return workspaceMembersInto(ctx, out.Live, ex, workspaceID) }
		roster := func() error { return channelRosterInto(ctx, out.Live, ex, workspaceID, channelID) }

		switch ch.Type {
		case channel.TypeChannel, channel.TypeJoint:
			// Public server-wide: both audiences are the workspace.
			if err := members(); err != nil {
				return err
			}
			for uid := range out.Live {
				out.ServerRoom[uid] = struct{}{}
			}
		case channel.TypePrivate:
			// Roster-only channel: both audiences are the roster.
			if err := roster(); err != nil {
				return err
			}
			for uid := range out.Live {
				out.ServerRoom[uid] = struct{}{}
			}
		case channel.TypeDM:
			// Generic membership intents must never turn a DM identifier
			// into a workspace-wide hint. Its policy audience is participants.
			if err := roster(); err != nil {
				return err
			}
			for uid := range out.Live {
				out.ServerRoom[uid] = struct{}{}
			}
		case channel.TypeThread:
			// Thread changes have their own parent-aware event projectors.
			// Do not invent a server-wide fallback for an unexpected generic
			// channel intent that might identify a private-parent thread.
			exists = false
			return nil
		default:
			exists = false
			return nil
		}
		return d.authorizeAudienceSetsTx(ctx, ex, workspaceID, channelID, out.Live, out.ServerRoom, out.Members)
	})
	if err != nil {
		return channelEventFacts{}, false, err
	}
	return out, exists, nil
}

func workspaceMembersInto(ctx context.Context, target map[string]struct{}, ex db.Executor, workspaceID string) error {
	rows, err := ex.QueryContext(ctx, `SELECT m.user_id FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
		workspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return err
		}
		target[userID] = struct{}{}
	}
	return rows.Err()
}

func channelRosterInto(ctx context.Context, target map[string]struct{}, ex db.Executor, workspaceID, channelID string) error {
	rows, err := ex.QueryContext(ctx, `SELECT ch.user_id FROM channel_humans ch
		JOIN channels c ON c.id = ch.channel_id
		WHERE ch.channel_id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL`,
		channelID, workspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return err
		}
		target[userID] = struct{}{}
	}
	return rows.Err()
}

// ChannelUpdatedEventPayload carries the current channel-row facts for the
// {channel} wire shape — never a viewer-private envelope (read frontier,
// mute/display prefs live only in per-user surfaces). The presenter renders
// the wire DTO via ChannelWire.
type ChannelUpdatedEventPayload struct {
	Channel channel.Channel
}

// ChannelMembershipGainedEventPayload is the targeted channel:updated
// variant for a newly-added human: the same row facts plus joined:true
// (inlined by the presenter).
type ChannelMembershipGainedEventPayload struct {
	Channel channel.Channel
}

func (d *Dispatcher) publishChannelUpdated(ctx context.Context, ref publication.Publication) error {
	facts, exists, err := d.resolveChannelEventFacts(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists {
		d.completed.Add(1)
		return nil
	}
	if d.serial() != facts.Serial {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	if err := d.deliverSetContext(ctx, facts.Serial, facts.Live, ref.WorkspaceID, EventChannelUpdated,
		ChannelUpdatedEventPayload{Channel: *facts.Channel}); err != nil {
		return err
	}
	d.published.Add(1)
	return nil
}

// ChannelMembersEventPayload is the exact TS shape {channelId}.
type ChannelMembersEventPayload struct {
	ChannelID string
}

func (d *Dispatcher) publishMembersUpdated(ctx context.Context, ref publication.Publication) error {
	facts, exists, err := d.resolveChannelEventFacts(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists {
		d.completed.Add(1)
		return nil
	}
	if d.serial() != facts.Serial {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	payload := ChannelMembersEventPayload{ChannelID: ref.ObjectID}
	if err := d.deliverSetContext(ctx, facts.Serial, facts.ServerRoom, ref.WorkspaceID, EventChannelMembers, payload); err != nil {
		return err
	}
	d.published.Add(1)

	// The TS pair: when a HUMAN's membership was gained, that user
	// additionally receives a targeted channel:updated carrying the current
	// projection with joined:true (channels.ts:390-392). The subject is a
	// durable reference from the intent, never a payload-supplied identity.
	if ref.SubjectUserID != "" {
		if _, stillMember := facts.Members[ref.SubjectUserID]; stillMember {
			gained := ChannelMembershipGainedEventPayload{Channel: *facts.Channel}
			if err := d.deliverSetContext(ctx, facts.Serial, map[string]struct{}{ref.SubjectUserID: {}},
				ref.WorkspaceID, EventChannelUpdated, gained); err != nil {
				return err
			}
		}
	}
	return nil
}
