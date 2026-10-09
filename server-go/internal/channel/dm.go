// Human direct messages over the canonical direct_messages pair table
// (migration 0010): (workspace, user_low, user_high) is the unique identity,
// self-DM stores exactly one roster row, and concurrent ensure calls converge
// on the same channel. Ports findOrCreateUserDM + listDMChannels' human
// subset; the agent-DM creation branch is intentionally absent (the HTTP
// surface answers an honest, pre-mutation 501 for it).
package channel

import (
	"context"
	"database/sql"
	"fmt"
	"sort"

	"raft.local/server-go/internal/publication"
)

// Legacy DM route sentences (channels.ts POST /channels/dm).
const (
	DMTargetNotMemberMessage = "User is not a member of this server"
	DMGuestCreateMessage     = "Guests cannot create direct messages"
	DMGuestTargetMessage     = "Guests cannot be added to new direct messages"
	dmFallbackName           = "User"
	// PublicationEventDMNew marks a DM conversation becoming visible to its
	// participants (first creation, or a later revive of a soft-deleted row).
	PublicationEventDMNew = "dm:new"
)

// dmPair orders two user ids into the canonical (low, high) form.
func dmPair(a, b string) (string, string) {
	if a <= b {
		return a, b
	}
	return b, a
}

// EnsureDMTx finds or creates the human DM conversation of userID and
// otherUserID in one transaction. Existing pairs return the same channel even
// when a participant is no longer eligible (a soft-deleted row is restored,
// mirroring the original ensure); new pairs require both users to be eligible
// workspace members and, under the frozen guest policy, neither side may be
// a guest.
func (s *Store) EnsureDMTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, otherUserID string) (*Channel, error) {
	role, err := s.eligibleHumanRole(ctx, tx, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
	}
	// Frozen disabled guest gate: a guest requester is refused before any
	// branch resolution, exactly like the original route.
	if role == RoleGuest {
		return nil, &DomainError{Code: CodeForbidden, Message: DMGuestCreateMessage}
	}
	self := userID == otherUserID
	low, high := dmPair(userID, otherUserID)

	// Target eligibility in the route's order; only then find-or-create. The
	// membership check doubles as the cross-workspace guard: a user of
	// another workspace has no role here.
	otherRole := ""
	if !self {
		var err error
		otherRole, err = s.eligibleHumanRole(ctx, tx, workspaceID, otherUserID)
		if err != nil {
			return nil, err
		}
		if otherRole == "" {
			return nil, &DomainError{Code: CodeInvalidInput, Message: DMTargetNotMemberMessage}
		}
		if otherRole == RoleGuest {
			return nil, &DomainError{Code: CodeForbidden, Message: DMGuestTargetMessage}
		}
	}

	existing, revived, err := s.readDMChannel(ctx, tx, workspaceID, low, high)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if revived {
			// A real revive must emit again: the intent revision is the
			// transition time, so the create-time key can never suppress it.
			if err := s.enqueueDMNew(ctx, tx, workspaceID, existing.ID); err != nil {
				return nil, err
			}
		}
		return existing, nil
	}

	peer := otherUserID
	if self {
		peer = userID
	}
	dmName := dmFallbackName
	peerName, err := s.userName(ctx, tx, peer)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if peerName != "" {
		dmName = peerName
	}

	id, err := newUUID()
	if err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, workspaceID, dmName, TypeDM, now); err != nil {
		return nil, fmt.Errorf("insert dm channel: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
		VALUES (?, ?, 'member', 1, ?)`, id, userID, now); err != nil {
		return nil, fmt.Errorf("insert dm roster (actor): %w", err)
	}
	if !self {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO channel_humans (channel_id, user_id, role, authority_revision, joined_at)
			VALUES (?, ?, 'member', 1, ?)`, id, otherUserID, now); err != nil {
			return nil, fmt.Errorf("insert dm roster (peer): %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO direct_messages (workspace_id, user_low, user_high, channel_id)
		VALUES (?, ?, ?, ?)`, workspaceID, low, high, id); err != nil {
		if isUniqueViolation(err) {
			// A concurrent ensure won the pair; converge on its channel.
			winner, winnerRevived, readErr := s.readDMChannel(ctx, tx, workspaceID, low, high)
			if readErr == nil && winner != nil {
				if winnerRevived {
					if err := s.enqueueDMNew(ctx, tx, workspaceID, winner.ID); err != nil {
						return nil, err
					}
				}
				return winner, nil
			}
		}
		return nil, fmt.Errorf("insert direct_messages: %w", err)
	}
	// hidePassivePeerOnCreate parity: the passive peer's sidebar keeps the
	// fresh conversation folded until real activity reaches them. The fact
	// lives in workspace_member_preferences.hidden_dm_ids (0005); the DM list
	// itself keeps returning the row, exactly like the original list route.
	if !self {
		if err := s.hideDMForPeer(ctx, tx, workspaceID, otherUserID, id); err != nil {
			return nil, err
		}
	}
	if err := s.enqueueDMNew(ctx, tx, workspaceID, id); err != nil {
		return nil, err
	}
	return s.getChannel(ctx, tx, id, false)
}

// enqueueDMNew records the dm:new intent for a real creation or revive. The
// revision is strictly greater than every previously committed intent of the
// same (workspace, channel, dm:new) key: max(transition time, previous+1).
// Each real transition therefore gets a fresh key — a later revive can never
// be suppressed by the create-time publication — while a replay of the SAME
// transition (transaction retry) recomputes the identical key and stays
// idempotent. Re-ensures without a transition never call this.
func (s *Store) enqueueDMNew(ctx context.Context, tx *sql.Tx, workspaceID, channelID string) error {
	var previous int64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(revision), 0) FROM realtime_publications
		WHERE workspace_id = ? AND object_type = 'channel' AND object_id = ? AND event_type = ?`,
		workspaceID, channelID, PublicationEventDMNew).Scan(&previous); err != nil {
		return fmt.Errorf("read dm:new revision frontier: %w", err)
	}
	revision := s.now().UnixMilli()
	if revision <= previous {
		revision = previous + 1
	}
	return publication.Enqueue(ctx, tx, publication.Publication{
		WorkspaceID: workspaceID,
		ObjectType:  "channel",
		ObjectID:    channelID,
		EventType:   PublicationEventDMNew,
		Revision:    revision,
		ScopeID:     channelID,
	})
}

// hideDMForPeer appends one channel id to the peer's hidden_dm_ids (set
// union, idempotent). The preferences row is created on demand; membership
// was verified by the caller.
func (s *Store) hideDMForPeer(ctx context.Context, tx *sql.Tx, workspaceID, peerUserID, channelID string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO workspace_member_preferences (workspace_id, user_id, hidden_dm_ids)
		VALUES (?, ?, json_array(?))
		ON CONFLICT (workspace_id, user_id) DO UPDATE SET
			hidden_dm_ids = (
				SELECT COALESCE(json_group_array(DISTINCT value), '[]')
				FROM (
					SELECT value FROM json_each(COALESCE(workspace_member_preferences.hidden_dm_ids, '[]'))
					UNION ALL SELECT ?
				)
			)`,
		workspaceID, peerUserID, channelID, channelID)
	if err != nil {
		return fmt.Errorf("hide dm for passive peer: %w", err)
	}
	return nil
}

// readDMChannel resolves the channel of an existing canonical pair,
// restoring a soft-deleted row exactly like the original ensure. revived
// reports whether a restore happened (a real transition for dm:new); nil
// without error means the pair has no conversation yet.
func (s *Store) readDMChannel(ctx context.Context, ex Executor, workspaceID, low, high string) (*Channel, bool, error) {
	var channelID string
	err := ex.QueryRowContext(ctx,
		`SELECT channel_id FROM direct_messages WHERE workspace_id = ? AND user_low = ? AND user_high = ?`,
		workspaceID, low, high).Scan(&channelID)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read direct_messages pair: %w", err)
	}
	channel, err := s.getChannel(ctx, ex, channelID, true)
	if err != nil {
		return nil, false, err
	}
	if channel == nil {
		return nil, false, fmt.Errorf("dm pair %s/%s references missing channel %s", low, high, channelID)
	}
	if channel.DeletedAt != nil {
		if _, err := ex.ExecContext(ctx,
			`UPDATE channels SET deleted_at = NULL WHERE id = ?`, channelID); err != nil {
			return nil, false, fmt.Errorf("restore soft-deleted dm: %w", err)
		}
		channel.DeletedAt = nil
		return channel, true, nil
	}
	return channel, false, nil
}

func (s *Store) userName(ctx context.Context, ex Executor, userID string) (string, error) {
	var name string
	err := ex.QueryRowContext(ctx, `SELECT name FROM users WHERE id = ?`, userID).Scan(&name)
	return name, err
}

// DMView is one human DM of the list projection: the channel row plus its
// resolved peer and last-message activity (a shared message fact).
type DMView struct {
	Channel          Channel
	PeerID           string
	PeerName         string
	PeerDisplayName  *string
	PeerDescription  *string
	PeerAvatarURL    *string
	PeerGravatarHash string
	LastMessageAt    *int64 // unix millis of the newest message, nil when none
}

// dmListColumns extends the channel row with the peer identity and the
// last-message timestamp used by ListDMsTx.
const dmListColumns = channelColumns + `,
	pu.id, pu.name, pu.display_name, pu.description, pu.avatar_url, pu.email,
	(SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id)`

// scanDMView scans one dmListColumns row (channelColumns order first).
func scanDMView(scanner interface{ Scan(dest ...any) error }) (*DMView, error) {
	var v DMView
	var description, systemKind, parentMessage, archivedByUser, archivedByAgent sql.NullString
	var peerDisplayName, peerDescription, peerAvatar, peerEmail sql.NullString
	var archivedAt, deletedAt, lastMessageAt sql.NullInt64
	var guestVisible, guestJoinable int
	var createdAt int64
	if err := scanner.Scan(&v.Channel.ID, &v.Channel.WorkspaceID, &v.Channel.Name, &description, &v.Channel.Type, &systemKind,
		&guestVisible, &guestJoinable, &parentMessage, &createdAt,
		&archivedAt, &archivedByUser, &archivedByAgent, &deletedAt,
		&v.PeerID, &v.PeerName, &peerDisplayName, &peerDescription, &peerAvatar, &peerEmail,
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
	v.PeerGravatarHash = gravatarHash(peerEmail.String)
	if lastMessageAt.Valid {
		millis := lastMessageAt.Int64
		v.LastMessageAt = &millis
	}
	return &v, nil
}

// ListDMsTx ports the human subset of listDMChannels: the viewer's canonical
// pairs of this workspace with live channels, resolved peer identity, and the
// last-message time used for ordering. Read/mute/display projections and the
// last-message preview belong to the readstate/message slices and are added
// by their owners.
func (s *Store) ListDMsTx(ctx context.Context, ex Executor, workspaceID, userID string) ([]DMView, error) {
	role, err := s.eligibleHumanRole(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" || role == RoleGuest {
		return []DMView{}, nil
	}
	rows, err := ex.QueryContext(ctx, `
		SELECT `+dmListColumns+`
		FROM direct_messages dm
		JOIN channels c
		  ON c.id = dm.channel_id
		 AND c.workspace_id = dm.workspace_id
		 AND c.type = 'dm'
		 AND c.deleted_at IS NULL
		JOIN users pu
		  ON pu.id = CASE WHEN dm.user_low = ? THEN dm.user_high ELSE dm.user_low END
		WHERE dm.workspace_id = ?
		  AND (dm.user_low = ? OR dm.user_high = ?)
		  AND EXISTS (SELECT 1 FROM channel_humans ch WHERE ch.channel_id = c.id AND ch.user_id = ?)
		  AND NOT EXISTS (SELECT 1 FROM channel_agents ca WHERE ca.channel_id = c.id)
		ORDER BY c.id`, userID, workspaceID, userID, userID, userID)
	if err != nil {
		return nil, fmt.Errorf("list dms: %w", err)
	}
	defer rows.Close()
	views := []DMView{}
	for rows.Next() {
		v, err := scanDMView(rows)
		if err != nil {
			return nil, err
		}
		views = append(views, *v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Most recent message first; DMs without messages keep creation order.
	sort.SliceStable(views, func(i, j int) bool {
		a, b := views[i].LastMessageAt, views[j].LastMessageAt
		switch {
		case a != nil && b != nil:
			if *a != *b {
				return *a > *b
			}
			return views[i].Channel.CreatedAt.Before(views[j].Channel.CreatedAt)
		case a != nil:
			return true
		case b != nil:
			return false
		default:
			return views[i].Channel.CreatedAt.Before(views[j].Channel.CreatedAt)
		}
	})
	return views, nil
}

// LookupDMTx resolves the live channel of an existing canonical pair without
// creating or resurrecting anything (route-level "existing DM" decisions).
func (s *Store) LookupDMTx(ctx context.Context, ex Executor, workspaceID, userID, otherUserID string) (*Channel, error) {
	low, high := dmPair(userID, otherUserID)
	channel, err := s.readDMChannelLive(ctx, ex, workspaceID, low, high)
	if err != nil || channel == nil {
		return nil, err
	}
	return channel, nil
}

// readDMChannelLive reads the pair's channel only when it is live (the DM
// list semantics); soft-deleted rows read as absent.
func (s *Store) readDMChannelLive(ctx context.Context, ex Executor, workspaceID, low, high string) (*Channel, error) {
	var channelID string
	err := ex.QueryRowContext(ctx,
		`SELECT dm.channel_id FROM direct_messages dm
		 JOIN channels c ON c.id = dm.channel_id AND c.deleted_at IS NULL
		 WHERE dm.workspace_id = ? AND dm.user_low = ? AND dm.user_high = ?`,
		workspaceID, low, high).Scan(&channelID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read live dm pair: %w", err)
	}
	return s.getChannel(ctx, ex, channelID, false)
}
