package realtime

// Conversation audience resolution: the CURRENT policy audience of one
// shared conversation fact, captured under one authority serial.

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/db"
)

// conversationAudience is the CURRENT policy audience of one shared
// conversation fact. live is who may receive live delivery for it (rooms are
// only a subscription index, never the authority); counting is whose unread
// state a new message there can change (threads count followers only).
// serial binds the whole resolution to the authority snapshot it was
// computed under.
type conversationAudience struct {
	ChannelID    string
	PublicThread bool
	ChannelType  string
	Live         map[string]struct{}
	Counting     map[string]struct{}
	Serial       uint64
}

// resolveConversationAudience applies the approved live rules on one read
// snapshot, captured under serial0:
//
//   - public channel           → live/counting = current workspace members;
//   - private channel          → roster members;
//   - dm                       → participants;
//   - thread on a public parent  → live candidates = current workspace members;
//     message events additionally intersect each socket's thread room,
//     counting = active followers;
//   - thread on private/DM root → live = counting = active followers ONLY;
//   - missing conversation or broken parent chain → exists=false (complete
//     without delivery).
//
// ResolveConversationAudience resolves the current policy audience of one
// conversation. Exported for integration tests; production dispatch flows
// through Dispatch.
func (d *Dispatcher) ResolveConversationAudience(ctx context.Context, workspaceID, channelID string) (conversationAudience, bool, error) {
	return d.resolveConversationAudience(ctx, workspaceID, channelID)
}

func (d *Dispatcher) resolveConversationAudience(ctx context.Context, workspaceID, channelID string) (conversationAudience, bool, error) {
	serial0 := d.serial()
	out := conversationAudience{ChannelID: channelID, Serial: serial0, Live: map[string]struct{}{}, Counting: map[string]struct{}{}}
	exists := false
	err := db.WithReadSnapshot(ctx, d.db, func(ex db.Executor) error {
		var chType string
		var parentType sql.NullString
		row := ex.QueryRowContext(ctx, `SELECT c.type,
				(SELECT pc.type FROM messages pm
				 JOIN channels pc ON pc.id = pm.channel_id AND pc.workspace_id = c.workspace_id
				 WHERE pm.id = c.parent_message_id AND pm.workspace_id = c.workspace_id)
			FROM channels c
			WHERE c.id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL`,
			channelID, workspaceID)
		if err := row.Scan(&chType, &parentType); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			return err
		}
		exists = true
		out.ChannelType = chType
		out.PublicThread = chType == "thread" && parentType.Valid && parentType.String == "channel"

		members := func() error {
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
				out.Live[userID] = struct{}{}
				out.Counting[userID] = struct{}{}
			}
			return rows.Err()
		}
		roster := func() error {
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
				out.Live[userID] = struct{}{}
				out.Counting[userID] = struct{}{}
			}
			return rows.Err()
		}
		followers := func() error {
			rows, err := ex.QueryContext(ctx, `SELECT user_id FROM thread_follows
				WHERE workspace_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`,
				workspaceID, channelID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var userID string
				if err := rows.Scan(&userID); err != nil {
					return err
				}
				out.Live[userID] = struct{}{}
				out.Counting[userID] = struct{}{}
			}
			return rows.Err()
		}

		var audienceErr error
		switch {
		case chType == "channel":
			audienceErr = members()
		case chType == "private" || chType == "dm":
			audienceErr = roster()
		case chType == "thread":
			switch {
			case !parentType.Valid:
				exists = false // broken parent chain: nothing authorized
				return nil
			case parentType.String == "channel":
				if err := members(); err != nil {
					return err
				}
				// Interest is only a candidate set: a follow cannot grant
				// base content authority or bypass the frozen guest gate.
				out.Counting = map[string]struct{}{}
				audienceErr = followersInto(ctx, out.Counting, ex, workspaceID, channelID)
			default:
				audienceErr = followers()
			}
		default:
			exists = false
			return nil
		}
		if audienceErr != nil {
			return audienceErr
		}
		return d.authorizeAudienceSetsTx(ctx, ex, workspaceID, channelID, out.Live, out.Counting)
	})
	if err != nil {
		return conversationAudience{}, false, err
	}
	return out, exists, nil
}

// authorizeAudienceSetsTx narrows subscription/roster candidates through the
// SAME base content policy used by HTTP/history/join. It runs on the caller's
// snapshot, before guarded queue admission. In particular, a residual follow
// after private-parent removal, a guest with the feature gate disabled, or a
// malformed/deleted thread parent can never acquire live content authority.
// Infrastructure errors propagate so the durable intent remains retryable.
func (d *Dispatcher) authorizeAudienceSetsTx(ctx context.Context, ex db.Executor, workspaceID, channelID string, sets ...map[string]struct{}) error {
	checked := map[string]bool{}
	for _, users := range sets {
		for userID := range users {
			allowed, seen := checked[userID]
			if !seen {
				conversation, err := d.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, userID, false)
				if err != nil && channel.AsDomainError(err) == nil {
					return err
				}
				allowed = err == nil && conversation != nil
				checked[userID] = allowed
			}
			if !allowed {
				delete(users, userID)
			}
		}
	}
	return nil
}

func followersInto(ctx context.Context, target map[string]struct{}, ex db.Executor, workspaceID, threadID string) error {
	rows, err := ex.QueryContext(ctx, `SELECT user_id FROM thread_follows
		WHERE workspace_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`,
		workspaceID, threadID)
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

// audienceStale reports whether the authority serial moved past the
// audience's binding. Checked after every read set and inside every guarded
// predicate.
func (d *Dispatcher) audienceStale(a conversationAudience) bool { return d.serial() != a.Serial }
