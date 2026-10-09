// M4 conversation authorization: one fail-closed base content policy shared
// by message history/context, sync/resume interest, DMs and threads (TS
// canUserAccessChannel / canUserPostToChannel / syncMessages visibility).
//
// Base content authorization and subscription interest are deliberately two
// different questions: history/context/explicit join need only the base read;
// sync/resume additionally require an active thread follow. Neither ever
// auto-follows. Every resolver runs inside the caller's transaction or
// snapshot executor so a demotion/removal racing the request is seen live.
package channel

import (
	"context"
	"database/sql"
	"fmt"
)

// Conversation is the base content authorization result for one viewer and
// one conversation channel. Channel is the requested channel; Root is the
// non-thread ancestor that owns membership (equal to Channel for non-threads).
// ParentMessageID is set only when Channel is a thread.
type Conversation struct {
	Channel         *Channel
	Root            *Channel
	ParentMessageID string
	Role            string
	IsMember        bool
}

// Legacy sentences reused by the M4 surfaces.
const postJoinRequiredMessage = "You must join this channel to send messages"

// ThreadChainDepthLimit bounds the parent-chain walk. Healthy data has at
// most one hop (threads cannot nest); the bound only fails closed on
// corrupted cycles instead of looping.
const ThreadChainDepthLimit = 8

// AuthorizeConversationTx resolves the base content policy for one viewer.
// posting=false answers "may read the content"; posting=true additionally
// enforces the posting policy (explicit or system-channel implicit membership
// on the root, thread inheritance, non-archived root and channel).
//
// Failure modes (typed DomainError for transport mapping):
//   - missing workspace membership          → FORBIDDEN NotServerMemberMessage
//   - missing/invisible/cross-space channel → NOT_FOUND "Channel not found"
//   - broken thread parent chain            → NOT_FOUND "Channel not found"
//   - posting without membership            → FORBIDDEN postJoinRequiredMessage
//   - archived channel or root              → CONFLICT "This channel is archived"
func (s *Store) AuthorizeConversationTx(ctx context.Context, ex Executor, workspaceID, channelID, userID string, posting bool) (*Conversation, error) {
	role, err := s.eligibleHumanRole(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
	}

	channel, err := s.getChannel(ctx, ex, channelID, false)
	if err != nil {
		return nil, err
	}
	if channel == nil || channel.WorkspaceID != workspaceID {
		return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}

	// Walk the thread parent chain to its root. Threads inherit both their
	// read and post policy from the root conversation; a follow row never
	// grants content access on its own.
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
			// Missing parent message, cross-space parent, nesting or a cycle
			// all fail closed as an invisible conversation.
			return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		if len(visited) >= ThreadChainDepthLimit {
			return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
		}
		visited[parentChannel.ID] = true
		root = parentChannel
	}

	member, err := s.isChannelHuman(ctx, ex, root.ID, userID)
	if err != nil {
		return nil, err
	}

	if posting {
		// Error precedence follows the original send route: the membership
		// decision (canUserPostToChannel → 403) runs before the archived
		// guard (assertChannelNotArchived → 409), so a stranger probing an
		// archived channel still gets the join sentence, not the archive
		// admission (messages.ts:1702-1706).
		if !canPostRoot(role, root, member) {
			return nil, &DomainError{Code: CodeForbidden, Message: postJoinRequiredMessage}
		}
		if channel.ArchivedAt != nil || root.ArchivedAt != nil {
			return nil, &DomainError{Code: CodeConflict, Message: "This channel is archived"}
		}
	} else if !canReadRoot(role, root, member) {
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

// canReadRoot ports the non-joint read decision of canUserAccessChannel for
// one root channel (the guest gate stays frozen/disabled and fails closed).
func canReadRoot(role string, root *Channel, member bool) bool {
	if role == RoleGuest {
		// Frozen disabled guest gate: no guest reads (see CanGuestReadChannel
		// with gateEnabled=false). Kept explicit so the policy is visible.
		return CanGuestReadChannel(false, role, root.Type, root.Name,
			IsAllSystemChannel(root) && !IsEnabledAllChannel(root),
			root.GuestVisible, root.GuestJoinable, member,
			root.ArchivedAt != nil, root.DeletedAt != nil)
	}
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

// canPostRoot shares the directory's implicit-membership rule with posting.
// An enabled #all or #announcement is a real conversation, not the Activity
// aggregation. Eligible workspace humans need no channel_humans row there;
// ordinary channels and DMs still require the explicit root roster. The
// caller has already established a current eligible workspace membership.
// This restores the original TS contract and avoids joined=true channels
// whose unchanged UI offers no Join action yet cannot send.
func canPostRoot(role string, root *Channel, member bool) bool {
	if role == RoleGuest {
		return false // frozen disabled guest gate
	}
	if IsAllSystemChannel(root) && !IsEnabledAllChannel(root) {
		return false
	}
	return HasImplicitServerMembership(root) || member
}

// threadRootChannel resolves the channel holding the parent message of a
// thread, with the cross-space and existence guards. nil means the chain is
// broken and the conversation must be treated as invisible.
func (s *Store) threadRootChannel(ctx context.Context, ex Executor, workspaceID, parentMessageID string) (*Channel, error) {
	var msgWorkspace, msgChannel string
	err := ex.QueryRowContext(ctx,
		`SELECT workspace_id, channel_id FROM messages WHERE id = ?`,
		parentMessageID).Scan(&msgWorkspace, &msgChannel)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read thread parent message: %w", err)
	}
	if msgWorkspace != workspaceID {
		return nil, nil
	}
	parent, err := s.getChannel(ctx, ex, msgChannel, false)
	if err != nil {
		return nil, err
	}
	if parent == nil || parent.WorkspaceID != workspaceID {
		return nil, nil
	}
	return parent, nil
}

// SelectSyncAudienceTx answers whether one channel belongs to the viewer's
// message-stream subscription set: base content authorization plus, for
// threads, an active follow. It never mutates follow state. The same rule
// gates HTTP /messages/sync and Socket resume (public-thread live may include
// explicit viewers; private/DM-thread streams are active followers only —
// see docs/m4-channel-worker-report.md).
func (s *Store) SelectSyncAudienceTx(ctx context.Context, ex Executor, workspaceID, channelID, userID string) (bool, error) {
	conv, err := s.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, userID, false)
	if err != nil {
		return false, err
	}
	if conv.Channel.Type != TypeThread {
		return true, nil
	}
	following, err := s.HasActiveThreadFollowTx(ctx, ex, workspaceID, userID, conv.Channel.ID)
	if err != nil {
		return false, err
	}
	return following, nil
}

// ListSubscriptionsTx returns every channel of the workspace whose new
// messages may enter the viewer's sync/resume stream, mirroring the original
// syncMessages visibility condition: public channels server-wide, private/DM
// by roster row, threads by active follow plus a readable, non-hidden parent
// chain. Reading history or opening a thread never adds a subscription.
func (s *Store) ListSubscriptionsTx(ctx context.Context, ex Executor, workspaceID, userID string) ([]string, error) {
	role, err := s.eligibleHumanRole(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" || role == RoleGuest {
		// No membership at all, or the frozen disabled guest gate: the sync
		// audience is honestly empty rather than broadly visible.
		return []string{}, nil
	}
	rows, err := ex.QueryContext(ctx, `
		SELECT c.id FROM channels c
		WHERE c.workspace_id = ?
		  AND c.deleted_at IS NULL
		  AND NOT (c.name = 'all' AND c.type <> 'channel')
		  AND (
		    c.type = 'channel'
		    OR (
		      c.type IN ('private', 'dm')
		      AND EXISTS (
		        SELECT 1 FROM channel_humans ch
		        WHERE ch.channel_id = c.id AND ch.user_id = ?
		      )
		    )
		    OR (
		      c.type = 'thread'
		      AND EXISTS (
		        SELECT 1 FROM thread_follows tf
		        WHERE tf.thread_channel_id = c.id
		          AND tf.workspace_id = c.workspace_id
		          AND tf.user_id = ?
		          AND tf.unfollowed_at IS NULL
		      )
		      AND EXISTS (
		        SELECT 1
		        FROM messages pm
		        JOIN channels pc ON pc.id = pm.channel_id
		        LEFT JOIN channel_humans pch
		          ON pch.channel_id = pc.id AND pch.user_id = ?
		        WHERE pm.id = c.parent_message_id
		          AND pm.workspace_id = c.workspace_id
		          AND pc.workspace_id = c.workspace_id
		          AND pc.type IN ('channel', 'private', 'dm', 'joint')
		          AND pc.deleted_at IS NULL
		          AND NOT (pc.name = 'all' AND pc.type <> 'channel')
		          AND (pc.type = 'channel' OR pch.user_id IS NOT NULL)
		      )
		    )
		  )
		ORDER BY c.id`, workspaceID, userID, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("list sync subscriptions: %w", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// HasPriorChannelRelationshipTx ports hasPriorChannelRelationship over the
// current roster row, a thread follow row (which survives losing the parent),
// canonical DM participation, or real receiver-owned read/Done/mention
// residue. A deleted roster row is NOT historical evidence. Merely reading
// history does not create a witness. This preserves the reference 403/404
// split without revealing a resource from another receiver's private state.
func (s *Store) HasPriorChannelRelationshipTx(ctx context.Context, ex Executor, userID, channelID string) (bool, error) {
	queries := []struct {
		query string
		args  []any
	}{
		{`SELECT 1 FROM channel_humans WHERE channel_id = ? AND user_id = ? LIMIT 1`, []any{channelID, userID}},
		{`SELECT 1 FROM thread_follows WHERE thread_channel_id = ? AND user_id = ? LIMIT 1`, []any{channelID, userID}},
		{`SELECT 1 FROM user_channel_read_states r JOIN channels c ON c.id=r.channel_id AND c.workspace_id=r.workspace_id WHERE r.channel_id=? AND r.user_id=? LIMIT 1`, []any{channelID, userID}},
		{`SELECT 1 FROM user_channel_done_states r JOIN channels c ON c.id=r.channel_id AND c.workspace_id=r.workspace_id WHERE r.channel_id=? AND r.user_id=? LIMIT 1`, []any{channelID, userID}},
		{`SELECT 1 FROM user_mention_suppressions r JOIN channels c ON c.id=r.channel_id AND c.workspace_id=r.workspace_id WHERE r.channel_id=? AND r.user_id=? LIMIT 1`, []any{channelID, userID}},
		{`SELECT 1 FROM direct_messages WHERE channel_id = ? AND (user_low = ? OR user_high = ?) LIMIT 1`, []any{channelID, userID, userID}},
	}
	for _, q := range queries {
		var one int
		err := ex.QueryRowContext(ctx, q.query, q.args...).Scan(&one)
		if err == nil {
			return true, nil
		}
		if err != sql.ErrNoRows {
			return false, fmt.Errorf("read prior channel relationship: %w", err)
		}
	}
	return false, nil
}
