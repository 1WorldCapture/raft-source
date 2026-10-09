package message

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
)

// CreateInput is the locked cross-module creation input. AttachmentIDs and
// AsTask exist only so unsupported effects can be REJECTED before commit with
// the exact 501 body; they are never persisted in M4.
type CreateInput struct {
	ChannelID     string
	Content       string
	RandomID      *string
	Mentions      []Mention
	AttachmentIDs []string
	AsTask        *bool
}

// CreateResult carries the committed (or replayed) message plus the mention
// facts projected for the sender response. ThreadReply reports that this was
// a NEW reply into a thread channel (the application use case pairs it with
// the author's own read advance in the same transaction); a randomId replay
// or a non-thread message never sets it.
type CreateResult struct {
	Message     *Message
	Replayed    bool
	ThreadReply bool
	Mentions    []Mention
}

// CreateMessageTx is the transaction-bound creation STEP: identity
// revalidation, shape validation, posting authority, random-id idempotency,
// mention resolution, the message fact and the thread auto-follows — and
// NOTHING else. It is orchestrated by application/messaging, which pairs a
// NEW thread reply's read advance with the publication intents in the
// original pipeline order (follows -> read advance -> publications). It is
// never a complete human send on its own.
func (s *Store) CreateMessageTx(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID string, input CreateInput) (*CreateResult, error) {
	if err := s.validateHuman(ctx, tx, claims); err != nil {
		return nil, err
	}
	if err := validateCreateShape(input); err != nil {
		return nil, err
	}
	conv, err := s.authorizePost(ctx, tx, workspaceID, input.ChannelID, claims.Subject, "send messages")
	if err != nil {
		return nil, err
	}
	if conv.Channel == nil {
		return nil, fmt.Errorf("conversation without channel")
	}

	// Random-id replay: the (sender_type, sender_id, random_id) scope is
	// global across workspaces exactly like the TS index; a replay must
	// revalidate the current authorization (done above) and the request
	// digest before returning the original message.
	if input.RandomID != nil && *input.RandomID != "" {
		existing, err := s.lookupByRandomID(ctx, tx, claims.Subject, *input.RandomID)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			if existing.WorkspaceID != workspaceID || existing.ChannelID != input.ChannelID ||
				existing.RequestDigest != requestDigest(workspaceID, input.ChannelID, "user", claims.Subject, input.Content, mentionIdentities(input.Mentions)) {
				return nil, &RandomIDConflict{Reason: "randomId has already been used for a different message"}
			}
			mentions, err := s.mentionsOf(ctx, tx, existing.ID)
			if err != nil {
				return nil, err
			}
			return &CreateResult{Message: existing, Replayed: true, Mentions: mentions}, nil
		}
	}

	resolved, err := s.resolveMentions(ctx, tx, workspaceID, conv, input.Mentions)
	if err != nil {
		return nil, err
	}

	digest := requestDigest(workspaceID, input.ChannelID, "user", claims.Subject, input.Content, mentionIdentities(resolved))
	id := auth.NewUUID()
	now := s.now().UnixMilli()
	res, err := tx.ExecContext(ctx, `INSERT INTO messages
		(id, workspace_id, channel_id, sender_type, sender_id, content, message_type,
		 random_id, request_digest, thread_id, revision, created_at)
		VALUES (?,?,?, 'user', ?, ?, 'chat', ?, ?, NULL, 1, ?)`,
		id, workspaceID, input.ChannelID, claims.Subject, input.Content,
		nullableString(input.RandomID), digest, now)
	if err != nil {
		return nil, fmt.Errorf("insert message: %w", err)
	}
	seq, err := res.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("allocate seq: %w", err)
	}
	if seq <= 0 || seq > 9_007_199_254_740_991 {
		return nil, fmt.Errorf("seq %d is outside the safe-integer range", seq)
	}

	for _, m := range resolved {
		if _, err := tx.ExecContext(ctx, `INSERT INTO message_mentions (message_id, user_id, workspace_id)
			VALUES (?,?,?)`, id, m.ID, workspaceID); err != nil {
			return nil, fmt.Errorf("insert mention: %w", err)
		}
	}

	msg := &Message{
		Seq: seq, ID: id, WorkspaceID: workspaceID, ChannelID: input.ChannelID,
		SenderType: "user", SenderID: claims.Subject, Content: input.Content,
		MessageType: "chat", RandomID: input.RandomID,
		RequestDigest: digest, Revision: 1, CreatedAtUnix: now,
	}
	msg.CreatedAt = s.now().UTC()

	// Automatic thread interest per the TS fixture: the reply sender follows
	// the thread (reactivating an explicit unfollow), and each mentioned
	// human in a thread is (re)activated. Follow facts are channel-owned.
	// The author's read-latest advances in the SAME transaction through the
	// injected readstate hook — a rollback can never leave a phantom read or
	// a reply without its required read effect.
	if conv.Channel.Type == channel.TypeThread {
		if err := s.setThreadFollow(ctx, tx, workspaceID, conv.Channel.ID, claims.Subject); err != nil {
			return nil, err
		}
		for _, m := range resolved {
			if m.ID == claims.Subject {
				continue
			}
			if err := s.setThreadFollow(ctx, tx, workspaceID, conv.Channel.ID, m.ID); err != nil {
				return nil, err
			}
		}
	}

	return &CreateResult{Message: msg, ThreadReply: conv.Channel.Type == channel.TypeThread, Mentions: resolved}, nil
}

// RecordSendPublicationsTx records the durable broadcast intents for one
// committed send: message:new always, thread:updated for a NEW thread reply
// (revision = the reply's seq, exactly like the original pipeline). The
// messaging use case calls it in the SAME transaction AFTER the thread-reply
// read advance, so the realtime_publications row order matches the original
// send path (read_state intents first, then message:new, then
// thread:updated). A replay records nothing.
func (s *Store) RecordSendPublicationsTx(ctx context.Context, tx *sql.Tx, workspaceID string, created *CreateResult) error {
	if created == nil || created.Replayed || created.Message == nil {
		return nil
	}
	if err := enqueue(ctx, tx, workspaceID, "message", created.Message.ID, "message:new", 1, "", created.Message.ChannelID); err != nil {
		return err
	}
	if created.ThreadReply {
		return enqueue(ctx, tx, workspaceID, "thread", created.Message.ChannelID, "thread:updated", created.Message.Seq, "", created.Message.ChannelID)
	}
	return nil
}

// validateCreateShape reproduces the TS parse/validation order so error
// precedence matches the original handlers: body shape, randomId, mentions
// payload, required fields, content bounds; then the M4 unsupported-effect
// rejections that must fire before any authorization or write.
func validateCreateShape(input CreateInput) error {
	if !isUUID(input.ChannelID) {
		return &InvalidInput{Reason: "Invalid message request body"}
	}
	if input.RandomID != nil {
		rid := *input.RandomID
		if rid == "" || utf16Length(rid) > MaxRandomIDLength {
			return &InvalidInput{Reason: "randomId must be a non-empty string with at most 128 characters"}
		}
	}
	if err := validateMentionShapes(input.Mentions); err != nil {
		return err
	}
	if input.ChannelID == "" || input.Content == "" {
		return &InvalidInput{Reason: "Channel ID and content are required"}
	}
	if jsTrim(input.Content) == "" {
		return &InvalidInput{Reason: "Message content cannot be empty"}
	}
	if utf16Length(input.Content) > MaxContentCodeUnits {
		return &InvalidInput{Reason: "Message content exceeds maximum length of 32000 characters"}
	}
	// M4 disabled effects are rejected only after the legacy 400 precedence is
	// exhausted, and always BEFORE authorization and the write.
	for _, m := range input.Mentions {
		if m.Type == "agent" {
			return &UnsupportedEffect{Reason: "Agent mentions are not enabled in this server stage"}
		}
	}
	if len(input.AttachmentIDs) > 0 {
		return &UnsupportedEffect{Reason: "Attachments are not enabled in this server stage"}
	}
	if input.AsTask != nil && *input.AsTask {
		return &UnsupportedEffect{Reason: "Tasks are not enabled in this server stage"}
	}
	return nil
}

// validateMentionShapes mirrors parseStructuredMentions: type user|agent,
// UUID id, non-blank name <=128 units, de-duplicated by type:id:name.
// Agent-typed entries then hit the explicit 501 (whole write rejected, no
// partial acceptance).
func validateMentionShapes(mentions []Mention) error {
	seen := map[string]bool{}
	for _, m := range mentions {
		if m.Type != "user" && m.Type != "agent" {
			return &InvalidInput{Reason: "Invalid mentions payload"}
		}
		if !isUUID(m.ID) {
			return &InvalidInput{Reason: "Invalid mentions payload"}
		}
		name := jsTrim(m.Name)
		if name == "" || utf16Length(m.Name) > MaxMentionNameLen {
			return &InvalidInput{Reason: "Invalid mentions payload"}
		}
		key := m.Type + ":" + m.ID + ":" + name
		if seen[key] {
			continue
		}
		seen[key] = true
	}
	return nil
}

// resolveMentions verifies each structured user mention against the live
// directory inside the transaction: the target must be a current workspace
// member, must be able to READ this conversation, and the claimed handle must
// equal the directory handle so a client cannot render @someone-else. The
// persisted name is always the directory projection.
func (s *Store) resolveMentions(ctx context.Context, ex channelExecutor, workspaceID string, conv *channel.Conversation, mentions []Mention) ([]Mention, error) {
	if len(mentions) == 0 {
		return nil, nil
	}
	byHandle := map[string]Mention{}
	bound := map[string]string{} // handle -> type:id
	for _, m := range mentions {
		handle := jsTrim(m.Name)
		if prev, ok := bound[handle]; ok && prev != m.Type+":"+m.ID {
			return nil, &MentionBindingConflict{Handle: handle}
		}
		bound[handle] = m.Type + ":" + m.ID
		byHandle[handle] = m
	}
	var resolved []Mention
	seenTarget := map[string]bool{}
	// Deterministic order: by handle.
	handles := make([]string, 0, len(byHandle))
	for h := range byHandle {
		handles = append(handles, h)
	}
	sort.Strings(handles)
	for _, handle := range handles {
		m := byHandle[handle]
		var name string
		var displayName, description sql.NullString
		err := ex.QueryRowContext(ctx, `SELECT u.name, u.display_name, u.description
			FROM users u
			JOIN workspace_memberships wm ON wm.user_id = u.id AND wm.workspace_id = ?
			WHERE u.id = ?`, workspaceID, m.ID).Scan(&name, &displayName, &description)
		if err == sql.ErrNoRows {
			return nil, &InvalidInput{Reason: fmt.Sprintf("Mention @%s is not a member of this workspace", handle)}
		}
		if err != nil {
			return nil, fmt.Errorf("mention directory lookup: %w", err)
		}
		if name != handle {
			return nil, &InvalidInput{Reason: fmt.Sprintf("Mention @%s does not match the workspace directory", handle)}
		}
		// Same handle bound to two different actors is the TS v2 binding
		// conflict; duplicates by target id are silently merged like TS.
		if seenTarget[m.Type+":"+m.ID] {
			continue
		}
		// Read authority for the mentioned user over THIS conversation.
		if _, err := s.authorizeRead(ctx, ex, workspaceID, conv.Channel.ID, m.ID); err != nil {
			if errors.Is(err, ErrConversationDenied) {
				return nil, &InvalidInput{Reason: fmt.Sprintf("Mention @%s cannot read this conversation", handle)}
			}
			return nil, err
		}
		seenTarget[m.Type+":"+m.ID] = true
		resolved = append(resolved, Mention{Type: "user", ID: m.ID, Name: name})
	}
	return resolved, nil
}

// lookupByRandomID finds the sender's earlier commit of the same random key.
// The uniqueness scope is (sender_type, sender_id, random_id) across all
// workspaces, exactly like the TS partial unique index.
func (s *Store) lookupByRandomID(ctx context.Context, ex channel.Executor, senderID, randomID string) (*Message, error) {
	row := ex.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages m
		WHERE m.sender_type = 'user' AND m.sender_id = ? AND m.random_id = ? LIMIT 1`, senderID, randomID)
	msg, err := scanMessage(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("random id lookup: %w", err)
	}
	return msg, nil
}

// mentionsOf loads the persisted mention facts of one message in insertion
// order (message_mentions has no created_at; order by rowid).
func (s *Store) mentionsOf(ctx context.Context, ex channel.Executor, messageID string) ([]Mention, error) {
	rows, err := ex.QueryContext(ctx, `SELECT mm.user_id, u.name FROM message_mentions mm
		JOIN users u ON u.id = mm.user_id
		WHERE mm.message_id = ? ORDER BY mm.rowid`, messageID)
	if err != nil {
		return nil, fmt.Errorf("mention read: %w", err)
	}
	defer rows.Close()
	var out []Mention
	for rows.Next() {
		var m Mention
		if err := rows.Scan(&m.ID, &m.Name); err != nil {
			return nil, err
		}
		m.Type = "user"
		out = append(out, m)
	}
	return out, rows.Err()
}

// requestDigest is the replay fingerprint: workspace, channel, sender
// identity, content and the SORTED mention target identities (type:id only —
// directory names may legitimately change between send and retry).
func requestDigest(workspaceID, channelID, senderType, senderID, content string, mentionKeys []string) string {
	keys := append([]string(nil), mentionKeys...)
	sort.Strings(keys)
	payload, _ := json.Marshal(struct {
		WorkspaceID string   `json:"workspaceId"`
		ChannelID   string   `json:"channelId"`
		SenderType  string   `json:"senderType"`
		SenderID    string   `json:"senderId"`
		Content     string   `json:"content"`
		Mentions    []string `json:"mentions"`
	}{workspaceID, channelID, senderType, senderID, content, keys})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func mentionIdentities(mentions []Mention) []string {
	out := make([]string, 0, len(mentions))
	for _, m := range mentions {
		out = append(out, m.Type+":"+m.ID)
	}
	return out
}

func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}
