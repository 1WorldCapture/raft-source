package message

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"raft.local/server-go/internal/channel"
)

// MaxEmojiCodeUnits mirrors the TS MAX_REACTION_LENGTH=16 (JS length units).
const MaxEmojiCodeUnits = 16

// ReactionViewerState is the private projection for the acting viewer.
type ReactionViewerState struct {
	ViewerVersion int64
	ReactedEmojis []string
}

// ReactionMutation is the committed result of one add/remove.
type ReactionMutation struct {
	Message *Message
	Changed bool
	Viewer  ReactionViewerState
}

// ValidateEmoji ports parseReactionEmoji: trimmed, non-empty, <=16 UTF-16
// units, no embedded whitespace.
func ValidateEmoji(raw string) (string, bool) {
	emoji := strings.TrimSpace(raw)
	if emoji == "" || utf16Length(emoji) > MaxEmojiCodeUnits {
		return "", false
	}
	if strings.ContainsAny(emoji, " \t\n\r\v\f") {
		return "", false
	}
	for _, r := range emoji {
		if isJSWhitespace(r) {
			return "", false
		}
	}
	return emoji, true
}

// AddReaction commits one idempotent human reaction and its projections.
func (s *Store) AddReaction(ctx context.Context, claims Claims, workspaceID, messageID, emoji string) (*ReactionMutation, error) {
	return s.mutateReaction(ctx, claims, workspaceID, messageID, emoji, true)
}

// RemoveReaction removes one reaction idempotently.
func (s *Store) RemoveReaction(ctx context.Context, claims Claims, workspaceID, messageID, emoji string) (*ReactionMutation, error) {
	return s.mutateReaction(ctx, claims, workspaceID, messageID, emoji, false)
}

func (s *Store) mutateReaction(ctx context.Context, claims Claims, workspaceID, messageID, rawEmoji string, add bool) (*ReactionMutation, error) {
	emoji, ok := ValidateEmoji(rawEmoji)
	if !ok {
		return nil, &InvalidInput{Reason: "A valid emoji is required"}
	}
	var out *ReactionMutation
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		if err := s.validateHuman(ctx, tx, claims.claims); err != nil {
			return err
		}
		msg, conv, err := s.visibleMessage(ctx, tx, workspaceID, messageID, claims.userID)
		if err != nil || msg == nil {
			return err
		}
		if msg.MessageType == "system" || msg.SenderID == "system" {
			return ErrSystemMessage
		}
		// TS order: system check -> canPost (403) -> archived (409).
		if _, err := s.authorizePost(ctx, tx, workspaceID, conv.Channel.ID, claims.userID, "react to messages"); err != nil {
			return err
		}

		var changed bool
		if add {
			res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO message_reactions
				(message_id, user_id, emoji, created_at) VALUES (?,?,?,?)`,
				msg.ID, claims.userID, emoji, s.now().UnixMilli())
			if err != nil {
				return fmt.Errorf("insert reaction: %w", err)
			}
			n, _ := res.RowsAffected()
			changed = n > 0
		} else {
			res, err := tx.ExecContext(ctx, `DELETE FROM message_reactions
				WHERE message_id = ? AND user_id = ? AND emoji = ?`,
				msg.ID, claims.userID, emoji)
			if err != nil {
				return fmt.Errorf("delete reaction: %w", err)
			}
			n, _ := res.RowsAffected()
			changed = n > 0
		}
		now := s.now().UnixMilli()
		if changed {
			// The aggregate revision changes only on an actual mutation; an
			// idempotent repeat keeps the revision and replays nothing.
			if _, err := tx.ExecContext(ctx, `UPDATE messages SET revision = revision + 1 WHERE id = ?`,
				msg.ID); err != nil {
				return fmt.Errorf("bump revision: %w", err)
			}
			msg.Revision++
			// Ordered counters advance atomically with the fact (reference
			// messageReactionService bump semantics).
			if _, err := bumpDiscussionVersion(ctx, tx, msg.ID, emoji, now); err != nil {
				return err
			}
			if _, err := bumpViewerVersion(ctx, tx, msg.ID, claims.userID, now); err != nil {
				return err
			}
		}
		viewer, err := s.viewerState(ctx, tx, msg.ID, claims.userID)
		if err != nil {
			return err
		}
		if changed {
			if err := enqueue(ctx, tx, workspaceID, "message", msg.ID, "message:updated", msg.Revision, "", msg.ChannelID); err != nil {
				return err
			}
			if err := enqueue(ctx, tx, workspaceID, "reaction_viewer", msg.ID, "reaction_viewer:updated",
				msg.Revision, claims.userID, msg.ChannelID); err != nil {
				return err
			}
		}
		out = &ReactionMutation{Message: msg, Changed: changed, Viewer: viewer}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ViewerSnapshot hydrates the current viewer state for one message.
func (s *Store) ViewerSnapshot(ctx context.Context, claims Claims, workspaceID, messageID string) (*ReactionViewerState, *Message, error) {
	var state *ReactionViewerState
	var msg *Message
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		if err := s.validateHuman(ctx, ex, claims.claims); err != nil {
			return err
		}
		m, conv, err := s.visibleMessage(ctx, ex, workspaceID, messageID, claims.userID)
		if err != nil || m == nil {
			return err
		}
		if m.MessageType == "system" || m.SenderID == "system" {
			return ErrSystemMessage
		}
		if conv.Channel.ArchivedAt != nil {
			return ErrChannelArchived
		}
		st, err := s.viewerState(ctx, ex, m.ID, claims.userID)
		if err != nil {
			return err
		}
		viewerCopy := st
		state, msg = &viewerCopy, m
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return state, msg, nil
}

// ReactionActor is one actor row of the actors listing.
type ReactionActor struct {
	ActorKind   string
	ActorID     string
	Name        string
	DisplayName string
}

// ReactionActorsPage is the actors listing result. ChannelType/ChannelID
// carry the parentScope projection of the discussion envelope.
type ReactionActorsPage struct {
	DiscussionVersion int64
	Actors            []ReactionActor
	NextCursor        *string
	ChannelID         string
	ChannelType       string
}

// ListReactionActors pages through the human actors of one emoji, mirroring
// the TS discussion-version + visibility-hash guarded cursor contract.
func (s *Store) ListReactionActors(ctx context.Context, claims Claims, workspaceID, messageID, emoji string, limit int, cursor string) (*ReactionActorsPage, error) {
	var page *ReactionActorsPage
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		if err := s.validateHuman(ctx, ex, claims.claims); err != nil {
			return err
		}
		msg, conv, err := s.visibleMessage(ctx, ex, workspaceID, messageID, claims.userID)
		if err != nil || msg == nil {
			return err
		}
		if msg.MessageType == "system" || msg.SenderID == "system" {
			return ErrSystemMessage
		}
		if conv.Channel.ArchivedAt != nil {
			return ErrChannelArchived
		}
		page, err = s.listReactionActors(ctx, ex, claims, workspaceID, msg, conv, emoji, limit, cursor)
		return err
	})
	if err != nil {
		return nil, err
	}
	return page, nil
}

func (s *Store) listReactionActors(ctx context.Context, ex dbExecutor, claims Claims, workspaceID string, msg *Message, conv *channel.Conversation, emoji string, limit int, cursor string) (*ReactionActorsPage, error) {
	ch := conv.Channel
	visible, err := s.visibleReactionActors(ctx, ex, workspaceID, ch, claims.userID, conv)
	if err != nil {
		return nil, err
	}
	visibilityHash := visibilityDigest(visible)

	var decoded *reactionActorsCursor
	if cursor != "" {
		decoded, err = decodeReactionActorsCursor(cursor, s.cursorSecret())
		if err != nil {
			return nil, err
		}
		if decoded.PrincipalID != claims.userID || decoded.ServerID != workspaceID ||
			decoded.MessageID != msg.ID || decoded.Emoji != emoji {
			return nil, &ReactionActorsCursorError{}
		}
		if decoded.VisibilityHash != visibilityHash {
			return nil, &ReactionVisibilityChanged{}
		}
	}

	version, err := readDiscussionVersion(ctx, ex, msg.ID, emoji)
	if err != nil {
		return nil, err
	}
	if decoded != nil && decoded.DiscussionVersion != version {
		return nil, &ReactionDiscussionChanged{CurrentVersion: version}
	}

	args := []any{msg.ID, emoji}
	cursorClause := ""
	if decoded != nil {
		cursorClause = " AND r.user_id > ?"
		args = append(args, decoded.ActorID)
	}
	if len(visible) > 0 {
		cursorClause += " AND r.user_id IN (" + placeholders(len(visible)) + ")"
		args = append(args, anyStrings(visible)...)
	} else {
		// No visible actor: the page is empty by construction.
		return &ReactionActorsPage{DiscussionVersion: version, Actors: []ReactionActor{}, ChannelID: ch.ID, ChannelType: ch.Type}, nil
	}
	args = append(args, limit+1)
	rows, err := ex.QueryContext(ctx, `SELECT r.user_id,
		u.name, COALESCE(NULLIF(u.display_name,''), NULLIF(u.name,''), 'Unknown user')
		FROM message_reactions r JOIN users u ON u.id = r.user_id
		WHERE r.message_id = ? AND r.emoji = ?`+cursorClause+`
		ORDER BY r.user_id LIMIT ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("reaction actors: %w", err)
	}
	defer rows.Close()
	var actors []ReactionActor
	for rows.Next() {
		var a ReactionActor
		a.ActorKind = "user"
		if err := rows.Scan(&a.ActorID, &a.Name, &a.DisplayName); err != nil {
			return nil, err
		}
		actors = append(actors, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Re-check the discussion version on the same snapshot boundary; the
	// snapshot pins a consistent view, the check documents the guard.
	versionAfter, err := readDiscussionVersion(ctx, ex, msg.ID, emoji)
	if err != nil {
		return nil, err
	}
	if versionAfter != version {
		return nil, &ReactionDiscussionChanged{CurrentVersion: versionAfter}
	}

	out := &ReactionActorsPage{DiscussionVersion: version, Actors: []ReactionActor{}, ChannelID: ch.ID, ChannelType: ch.Type}
	if len(actors) > limit {
		out.Actors = actors[:limit]
		next := encodeReactionActorsCursor(reactionActorsCursor{
			Kind:              reactionActorsCursorKind,
			PrincipalID:       claims.userID,
			ServerID:          workspaceID,
			ParentScopeKind:   parentScopeKind(ch),
			ParentScopeID:     ch.ID,
			MessageID:         msg.ID,
			Emoji:             emoji,
			DiscussionVersion: version,
			VisibilityHash:    visibilityHash,
			ActorKind:         "user",
			ActorID:           out.Actors[len(out.Actors)-1].ActorID,
		}, s.cursorSecret())
		out.NextCursor = &next
	} else {
		out.Actors = actors
	}
	return out, nil
}

func parentScopeKind(ch *channel.Channel) string {
	if ch.Type == channel.TypeThread {
		return "thread"
	}
	return "channel"
}

// visibleMessage loads the message and authorizes base read access on the
// supplied executor. A message whose channel the caller cannot read is a
// 404, byte-identical to a missing id (no existence oracle).
func (s *Store) visibleMessage(ctx context.Context, ex dbExecutor, workspaceID, messageID, userID string) (*Message, *channel.Conversation, error) {
	msg, err := s.getMessage(ctx, ex, workspaceID, messageID)
	if err != nil {
		return nil, nil, err
	}
	if msg == nil {
		return nil, nil, ErrMessageNotFound
	}
	conv, err := s.authorizeRead(ctx, ex, workspaceID, msg.ChannelID, userID)
	if err != nil {
		// An unreadable parent channel makes the message a plain 404, exactly
		// like loadVisibleMessageForUser.
		if errors.Is(err, ErrConversationDenied) {
			return nil, nil, ErrMessageNotFound
		}
		return nil, nil, err
	}
	return msg, conv, nil
}

// viewerState derives the private snapshot: sorted reacted emojis and the
// deterministic viewer version (equal version <=> equal payload, which the
// web conflict detector requires).
func (s *Store) viewerState(ctx context.Context, ex dbExecutor, messageID, userID string) (ReactionViewerState, error) {
	rows, err := ex.QueryContext(ctx, `SELECT emoji FROM message_reactions
		WHERE message_id = ? AND user_id = ? ORDER BY emoji`, messageID, userID)
	if err != nil {
		return ReactionViewerState{}, fmt.Errorf("viewer reactions: %w", err)
	}
	defer rows.Close()
	emojis := []string{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return ReactionViewerState{}, err
		}
		emojis = append(emojis, e)
	}
	if err := rows.Err(); err != nil {
		return ReactionViewerState{}, err
	}
	version, err := readViewerVersion(ctx, ex, messageID, userID)
	if err != nil {
		return ReactionViewerState{}, err
	}
	return ReactionViewerState{ViewerVersion: version, ReactedEmojis: sortEmojis(emojis)}, nil
}

// readDiscussionVersion returns the persisted per-(message,emoji) counter;
// absence means version 0. Database failures propagate — a fabricated
// version would silently break the 409 guard and the client merge order.
func readDiscussionVersion(ctx context.Context, ex dbExecutor, messageID, emoji string) (int64, error) {
	var version int64
	err := ex.QueryRowContext(ctx, `SELECT version FROM message_reaction_discussion_versions
		WHERE message_id = ? AND emoji = ?`, messageID, emoji).Scan(&version)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read discussion version: %w", err)
	}
	return version, nil
}

// readViewerVersion returns the persisted per-(message,viewer) counter;
// absence means version 0.
func readViewerVersion(ctx context.Context, ex dbExecutor, messageID, userID string) (int64, error) {
	var version int64
	err := ex.QueryRowContext(ctx, `SELECT version FROM message_reaction_viewer_versions
		WHERE message_id = ? AND user_id = ?`, messageID, userID).Scan(&version)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read viewer version: %w", err)
	}
	return version, nil
}

// bumpDiscussionVersion atomically increments the persisted discussion
// counter inside the caller's transaction and returns the new version.
func bumpDiscussionVersion(ctx context.Context, ex dbExecutor, messageID, emoji string, now int64) (int64, error) {
	res, err := ex.ExecContext(ctx, `INSERT INTO message_reaction_discussion_versions (message_id, emoji, version, updated_at)
		VALUES (?, ?, 1, ?)
		ON CONFLICT(message_id, emoji) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`,
		messageID, emoji, now)
	if err != nil {
		return 0, fmt.Errorf("bump discussion version: %w", err)
	}
	_ = res
	var version int64
	if err := ex.QueryRowContext(ctx, `SELECT version FROM message_reaction_discussion_versions
		WHERE message_id = ? AND emoji = ?`, messageID, emoji).Scan(&version); err != nil {
		return 0, fmt.Errorf("reread discussion version: %w", err)
	}
	return version, nil
}

// bumpViewerVersion atomically increments the persisted viewer counter.
func bumpViewerVersion(ctx context.Context, ex dbExecutor, messageID, userID string, now int64) (int64, error) {
	_, err := ex.ExecContext(ctx, `INSERT INTO message_reaction_viewer_versions (message_id, user_id, version, updated_at)
		VALUES (?, ?, 1, ?)
		ON CONFLICT(message_id, user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`,
		messageID, userID, now)
	if err != nil {
		return 0, fmt.Errorf("bump viewer version: %w", err)
	}
	var version int64
	if err := ex.QueryRowContext(ctx, `SELECT version FROM message_reaction_viewer_versions
		WHERE message_id = ? AND user_id = ?`, messageID, userID).Scan(&version); err != nil {
		return 0, fmt.Errorf("reread viewer version: %w", err)
	}
	return version, nil
}

// visibleReactionActors returns the actor ids the requester may see, porting
// the exact TS policy (getVisibleReactionActorIds): the channel roster (or
// the workspace membership for the implicit #all/announcement roster),
// filtered by the hidden-human-directory rules when the workspace hides its
// human directory from member-role requesters AND the scope is the #all
// directory (an #all channel, or a thread rooted in one).
func (s *Store) visibleReactionActors(ctx context.Context, ex dbExecutor, workspaceID string, ch *channel.Channel, requesterID string, conv *channel.Conversation) ([]string, error) {
	out, err := s.reactionActorRoster(ctx, ex, workspaceID, ch)
	if err != nil {
		return nil, err
	}
	hidden, err := s.humanDirectoryHiddenForRequester(ctx, ex, workspaceID, requesterID)
	if err != nil {
		return nil, err
	}
	if !hidden || !hiddenAllDirectoryScope(conv) {
		return out, nil
	}
	slug, err := s.workspaceSlug(ctx, ex, workspaceID)
	if err != nil {
		return nil, err
	}
	roles, err := s.memberRoles(ctx, ex, workspaceID)
	if err != nil {
		return nil, err
	}
	filtered := make([]string, 0, len(out))
	for _, actor := range out {
		if actor == requesterID || exposedInHiddenDirectory(slug, roles[actor]) {
			filtered = append(filtered, actor)
		}
	}
	return filtered, nil
}

// reactionActorRoster is the unfiltered roster half.
func (s *Store) reactionActorRoster(ctx context.Context, ex dbExecutor, workspaceID string, ch *channel.Channel) ([]string, error) {
	if channel.HasImplicitServerMembership(ch) {
		rows, err := ex.QueryContext(ctx, `SELECT user_id FROM workspace_memberships WHERE workspace_id = ?`, workspaceID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			out = append(out, id)
		}
		return out, rows.Err()
	}
	rows, err := ex.QueryContext(ctx, `SELECT user_id FROM channel_humans WHERE channel_id = ?`, ch.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// humanDirectoryHiddenForRequester ports shouldHideHumanDirectoryFromRequester:
// the workspace hides its human directory AND the requester holds the member
// role (owner/admin keep the full directory).
func (s *Store) humanDirectoryHiddenForRequester(ctx context.Context, ex dbExecutor, workspaceID, requesterID string) (bool, error) {
	var role string
	var hide bool
	err := ex.QueryRowContext(ctx, `SELECT m.role, w.hide_humans_from_members
		FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, requesterID).Scan(&role, &hide)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read directory visibility: %w", err)
	}
	return hide && role == "member", nil
}

// hiddenAllDirectoryScope ports isHiddenAllDirectoryScope: the #all system
// channel itself, or a thread whose root conversation is #all.
func hiddenAllDirectoryScope(conv *channel.Conversation) bool {
	if conv == nil || conv.Root == nil {
		return false
	}
	return channel.IsAllSystemChannel(conv.Root)
}

// exposedInHiddenDirectory ports shouldExposeHumanInHiddenDirectory: the
// requester themself, or a community-server owner/admin.
func exposedInHiddenDirectory(workspaceSlug, role string) bool {
	return (workspaceSlug == "community" || workspaceSlug == "community-cn") &&
		(role == "owner" || role == "admin")
}

func (s *Store) workspaceSlug(ctx context.Context, ex dbExecutor, workspaceID string) (string, error) {
	var slug string
	err := ex.QueryRowContext(ctx, `SELECT slug FROM workspaces WHERE id = ?`, workspaceID).Scan(&slug)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read workspace slug: %w", err)
	}
	return slug, nil
}

func (s *Store) memberRoles(ctx context.Context, ex dbExecutor, workspaceID string) (map[string]string, error) {
	rows, err := ex.QueryContext(ctx, `SELECT user_id, role FROM workspace_memberships WHERE workspace_id = ?`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("read member roles: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			return nil, err
		}
		out[id] = role
	}
	return out, rows.Err()
}

// visibilityDigest hashes the sorted visible-actor id list for the cursor's
// visibility guard (stability, not ordering, is the requirement here).
func visibilityDigest(parts []string) string {
	sorted := append([]string(nil), parts...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\x00")))
	return hex.EncodeToString(sum[:16])
}

// reactionActorsCursor is the signed pagination cursor, ported field-for-
// field from the TS contract (message-reaction-actors-v1).
const reactionActorsCursorKind = "message-reaction-actors-v1"

type reactionActorsCursor struct {
	Kind              string `json:"kind"`
	PrincipalID       string `json:"principalId"`
	ServerID          string `json:"serverId"`
	ParentScopeKind   string `json:"parentScopeKind"`
	ParentScopeID     string `json:"parentScopeId"`
	MessageID         string `json:"messageId"`
	Emoji             string `json:"emoji"`
	DiscussionVersion int64  `json:"discussionVersion"`
	VisibilityHash    string `json:"visibilityHash"`
	ActorKind         string `json:"actorKind"`
	ActorID           string `json:"actorId"`
}

var cursorSecretOnce sync.Once
var cursorSecretValue []byte

// cursorSecret returns the HMAC key for actor cursors. The parent injects the
// stable deployment secret; otherwise a process-random key is used (cursors
// are short-lived pagination state, never durable identity).
func (s *Store) cursorSecret() []byte {
	if s.fixedCursorSecret != nil {
		return s.fixedCursorSecret
	}
	cursorSecretOnce.Do(func() {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			panic(fmt.Sprintf("crypto/rand failed: %v", err))
		}
		cursorSecretValue = buf
	})
	return cursorSecretValue
}

func encodeReactionActorsCursor(c reactionActorsCursor, secret []byte) string {
	body, _ := json.Marshal(c)
	encoded := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(encoded))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + sig
}

func decodeReactionActorsCursor(raw string, secret []byte) (*reactionActorsCursor, error) {
	if len(raw) == 0 || len(raw) > 2048 {
		return nil, &ReactionActorsCursorError{}
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, &ReactionActorsCursorError{}
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0]))
	expected := mac.Sum(nil)
	supplied, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(expected, supplied) {
		return nil, &ReactionActorsCursorError{}
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, &ReactionActorsCursorError{}
	}
	var c reactionActorsCursor
	if err := json.Unmarshal(body, &c); err != nil {
		return nil, &ReactionActorsCursorError{}
	}
	if c.Kind != reactionActorsCursorKind || c.PrincipalID == "" || c.ServerID == "" ||
		(c.ParentScopeKind != "channel" && c.ParentScopeKind != "thread") ||
		c.ParentScopeID == "" || c.MessageID == "" || c.Emoji == "" ||
		c.DiscussionVersion < 0 || c.VisibilityHash == "" ||
		(c.ActorKind != "user" && c.ActorKind != "agent" && c.ActorKind != "external_projection") ||
		c.ActorID == "" {
		return nil, &ReactionActorsCursorError{}
	}
	return &c, nil
}
