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
	"strings"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
)

// CreateInput is the locked cross-module creation input. AttachmentIDs and
// AsTask exist only so unsupported effects can be REJECTED before commit with
// the exact 501 body; they are never persisted.
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
// or a non-thread message never sets it. RootChannelID is the root
// conversation that owns membership (equal to the channel for non-threads);
// the M5 send use case uses it to resolve the canonical Agent-DM receipt
// participant. Mentions may carry Type "user" and (M5) "agent".
type CreateResult struct {
	Message       *Message
	Replayed      bool
	ThreadReply   bool
	Mentions      []Mention
	RootChannelID string
}

// AgentMentionIDs returns the sorted, de-duplicated agent recipient targets
// of this creation (empty when none). The application send use case passes
// exactly these to the same-transaction delivery planner.
func (r *CreateResult) AgentMentionIDs() []string {
	if r == nil {
		return nil
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, m := range r.Mentions {
		if m.Type == "agent" && !seen[m.ID] {
			seen[m.ID] = true
			ids = append(ids, m.ID)
		}
	}
	sort.Strings(ids)
	return ids
}

// mentionScope selects which typed mention targets one sender may address.
type mentionScope int

const (
	// mentionScopeHuman: human sender. Agent-typed targets are resolved
	// against the live directory and persisted in message_agent_mentions.
	mentionScopeHuman mentionScope = iota
	// mentionScopeAgent: agent sender — human targets only. Agent-to-agent
	// mentions (including self) are refused before any write.
	mentionScopeAgent
)

// CreateMessageTx is the transaction-bound creation step for a human sender:
// identity revalidation, shape validation, posting authority, random-id
// idempotency, mention resolution (human and typed agent targets), the
// message fact and the thread auto-follows. Typed agent mentions are
// resolved against the live agent directory and the recipient's read+reply
// authority on the root conversation, then persisted in
// message_agent_mentions. Human targets stay in message_mentions. Any
// illegal target rejects the whole write before the message insert.
func (s *Store) CreateMessageTx(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID string, input CreateInput) (*CreateResult, error) {
	return s.createMessageTx(ctx, tx, "user", claims.Subject, workspaceID, input, mentionScopeHuman, claims)
}

// CreateAgentMessageTx is the transaction-bound creation STEP for an AGENT
// sender: agent conversation posting authority (real channel_agents /
// implicit-membership facts, never a human claim), agent-scoped random-id
// idempotency, human mention resolution, the sender_type='agent' message
// fact and the thread auto-follows for mentioned humans. The agent sender
// itself has no follow/read facts, and NO agent delivery intent is planned
// here — agent replies never cascade to other agents. The application use
// case owns the principal revalidation and the publication intents.
func (s *Store) CreateAgentMessageTx(ctx context.Context, tx *sql.Tx, agentID, workspaceID string, input CreateInput) (*CreateResult, error) {
	return s.createMessageTx(ctx, tx, "agent", agentID, workspaceID, input, mentionScopeAgent, auth.AccessTokenClaims{})
}

// createMessageTx is the shared creation engine. It never opens a
// transaction of its own and never decides publication/read policy.
func (s *Store) createMessageTx(ctx context.Context, tx *sql.Tx, senderType, senderID, workspaceID string, input CreateInput, scope mentionScope, claims auth.AccessTokenClaims) (*CreateResult, error) {
	if err := validateCreateShape(input, scope); err != nil {
		return nil, err
	}
	var conv *channel.Conversation
	if senderType == "user" {
		if err := s.validateHuman(ctx, tx, claims); err != nil {
			return nil, err
		}
		authorized, err := s.authorizePost(ctx, tx, workspaceID, input.ChannelID, senderID, "send messages")
		if err != nil {
			return nil, err
		}
		conv = authorized
	} else {
		authorized, err := s.authorizeAgentPost(ctx, tx, workspaceID, input.ChannelID, senderID)
		if err != nil {
			return nil, err
		}
		conv = authorized
	}
	if conv.Channel == nil {
		return nil, fmt.Errorf("conversation without channel")
	}

	// Random-id replay: the (sender_type, sender_id, random_id) scope is
	// global across workspaces exactly like the TS index; a replay must
	// revalidate the current authorization (done above) and the request
	// digest before returning the original message.
	if input.RandomID != nil && *input.RandomID != "" {
		existing, err := s.lookupByRandomID(ctx, tx, senderType, senderID, *input.RandomID)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			if existing.WorkspaceID != workspaceID || existing.ChannelID != input.ChannelID ||
				existing.RequestDigest != requestDigest(workspaceID, input.ChannelID, senderType, senderID, input.Content, mentionIdentities(input.Mentions)) {
				return nil, &RandomIDConflict{Reason: "randomId has already been used for a different message"}
			}
			mentions, err := s.mentionsOf(ctx, tx, existing.ID)
			if err != nil {
				return nil, err
			}
			return &CreateResult{Message: existing, Replayed: true, Mentions: mentions}, nil
		}
	}

	resolved, err := s.resolveMentions(ctx, tx, workspaceID, conv, input.Mentions, scope == mentionScopeHuman)
	if err != nil {
		return nil, err
	}

	digest := requestDigest(workspaceID, input.ChannelID, senderType, senderID, input.Content, mentionIdentities(resolved.combined()))
	id := auth.NewUUID()
	now := s.now().UnixMilli()
	res, err := tx.ExecContext(ctx, `INSERT INTO messages
		(id, workspace_id, channel_id, sender_type, sender_id, content, message_type,
		 random_id, request_digest, thread_id, revision, created_at)
		VALUES (?,?,?,?,?,?,'chat',?,?,NULL,1,?)`,
		id, workspaceID, input.ChannelID, senderType, senderID, input.Content,
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

	for _, m := range resolved.users {
		if _, err := tx.ExecContext(ctx, `INSERT INTO message_mentions (message_id, user_id, workspace_id)
			VALUES (?,?,?)`, id, m.ID, workspaceID); err != nil {
			return nil, fmt.Errorf("insert mention: %w", err)
		}
	}
	for _, m := range resolved.agents {
		if _, err := tx.ExecContext(ctx, `INSERT INTO message_agent_mentions
			(message_id, workspace_id, agent_id, handle_at_send, created_at)
			VALUES (?,?,?,?,?)`, id, workspaceID, m.ID, m.Name, now); err != nil {
			return nil, fmt.Errorf("insert agent mention: %w", err)
		}
	}

	msg := &Message{
		Seq: seq, ID: id, WorkspaceID: workspaceID, ChannelID: input.ChannelID,
		SenderType: senderType, SenderID: senderID, Content: input.Content,
		MessageType: "chat", RandomID: input.RandomID,
		RequestDigest: digest, Revision: 1, CreatedAtUnix: now,
	}
	msg.CreatedAt = s.now().UTC()

	// Automatic thread interest per the TS fixture: a HUMAN reply sender
	// follows the thread (reactivating an explicit unfollow), and each
	// mentioned human in a thread is (re)activated. An agent sender has no
	// follow facts; the mentioned humans keep theirs. Follow facts are
	// channel-owned.
	if conv.Channel.Type == channel.TypeThread {
		if senderType == "user" {
			if err := s.setThreadFollow(ctx, tx, workspaceID, conv.Channel.ID, senderID); err != nil {
				return nil, err
			}
		}
		for _, m := range resolved.users {
			if senderType == "user" && m.ID == senderID {
				continue
			}
			if err := s.setThreadFollow(ctx, tx, workspaceID, conv.Channel.ID, m.ID); err != nil {
				return nil, err
			}
		}
	}

	return &CreateResult{
		Message:       msg,
		ThreadReply:   conv.Channel.Type == channel.TypeThread,
		Mentions:      resolved.combined(),
		RootChannelID: conv.Root.ID,
	}, nil
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
// payload, required fields, content bounds; then the disabled-effect
// rejections that must fire before any authorization or write. An agent
// sender's agent-typed mention is refused here. A human sender's agent-typed
// mention continues into directory and receipt-authority resolution.
func validateCreateShape(input CreateInput, scope mentionScope) error {
	if !isUUID(input.ChannelID) {
		return &InvalidInput{Reason: "Invalid message request body"}
	}
	if input.RandomID != nil {
		rid := *input.RandomID
		maxLen := MaxRandomIDLength
		if scope == mentionScopeAgent {
			maxLen = MaxAgentRandomIDLength
		}
		if rid == "" || utf16Length(rid) > maxLen {
			return &InvalidInput{Reason: fmt.Sprintf("randomId must be a non-empty string with at most %d characters", maxLen)}
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
	// Disabled effects are rejected only after the legacy 400 precedence is
	// exhausted, and always BEFORE authorization and the write.
	for _, m := range input.Mentions {
		if m.Type != "agent" {
			continue
		}
		if scope == mentionScopeAgent {
			return &UnsupportedEffect{Reason: "Agent mentions of other agents are not enabled in this server stage"}
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
// An agent sender's agent-typed entries are refused by validateCreateShape
// before this returns; a human sender's agent-typed entries are resolved
// later and an illegal target rejects the whole write.
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

// resolvedMentions is the split outcome of mention resolution: the human
// targets (message_mentions) and the M5 typed agent targets
// (message_agent_mentions).
type resolvedMentions struct {
	users  []Mention
	agents []Mention
}

func (r *resolvedMentions) combined() []Mention {
	out := make([]Mention, 0, len(r.users)+len(r.agents))
	out = append(out, r.users...)
	out = append(out, r.agents...)
	return out
}

// resolveMentions verifies each structured mention against the live
// directories inside the transaction. Human targets must be current
// workspace members able to READ this conversation with a handle equal to
// the directory handle. Agent targets (M5 human scope only) must be live
// agents of this workspace whose stored handle matches, and the recipient
// must hold READ+REPLY authority over the conversation root — an explicit
// mention is a receipt promise, so an undeliverable target rejects the whole
// write instead of being silently dropped. One handle bound to two actors
// (across either type) is the TS v2 binding conflict; duplicates by target
// id are silently merged like TS. The persisted name is always the directory
// projection; deterministic order is by handle.
func (s *Store) resolveMentions(ctx context.Context, ex channelExecutor, workspaceID string, conv *channel.Conversation, mentions []Mention, resolveAgents bool) (*resolvedMentions, error) {
	out := &resolvedMentions{}
	if len(mentions) == 0 {
		return out, nil
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
	// Deterministic order: by handle.
	handles := make([]string, 0, len(byHandle))
	for h := range byHandle {
		handles = append(handles, h)
	}
	sort.Strings(handles)
	seenUser := map[string]bool{}
	seenAgent := map[string]bool{}
	for _, handle := range handles {
		m := byHandle[handle]
		if m.Type == "agent" {
			if !resolveAgents {
				// Shape validation already refused an agent sender. This is
				// the defense if a mention still reaches resolution.
				return nil, &UnsupportedEffect{Reason: "Agent mentions of other agents are not enabled in this server stage"}
			}
			if seenAgent[m.ID] {
				continue
			}
			var name string
			err := ex.QueryRowContext(ctx, `SELECT name FROM agents
				WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`, m.ID, workspaceID).Scan(&name)
			if err == sql.ErrNoRows {
				return nil, &InvalidInput{Reason: fmt.Sprintf("Mention @%s is not an agent of this workspace", handle)}
			}
			if err != nil {
				return nil, fmt.Errorf("agent mention directory lookup: %w", err)
			}
			if name != handle {
				return nil, &InvalidInput{Reason: fmt.Sprintf("Mention @%s does not match the agent directory", handle)}
			}
			// Receipt eligibility: the recipient must be able to read AND
			// reply in this conversation (the original agent posting rule).
			if err := s.authorizeAgentMentionTarget(ctx, ex, workspaceID, conv.Channel.ID, m.ID); err != nil {
				return nil, err
			}
			seenAgent[m.ID] = true
			out.agents = append(out.agents, Mention{Type: "agent", ID: m.ID, Name: name})
			continue
		}
		if seenUser[m.ID] {
			continue
		}
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
		// Read authority for the mentioned user over THIS conversation.
		if _, err := s.authorizeRead(ctx, ex, workspaceID, conv.Channel.ID, m.ID); err != nil {
			if errors.Is(err, ErrConversationDenied) {
				return nil, &InvalidInput{Reason: fmt.Sprintf("Mention @%s cannot read this conversation", handle)}
			}
			return nil, err
		}
		seenUser[m.ID] = true
		out.users = append(out.users, Mention{Type: "user", ID: m.ID, Name: name})
	}
	return out, nil
}

// lookupByRandomID finds the sender's earlier commit of the same random key.
// The uniqueness scope is (sender_type, sender_id, random_id) across all
// workspaces, exactly like the TS partial unique index.
func (s *Store) lookupByRandomID(ctx context.Context, ex channelExecutor, senderType, senderID, randomID string) (*Message, error) {
	row := ex.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages m
		WHERE m.sender_type = ? AND m.sender_id = ? AND m.random_id = ? LIMIT 1`, senderType, senderID, randomID)
	msg, err := scanMessage(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("random id lookup: %w", err)
	}
	return msg, nil
}

// mentionsOf loads the persisted mention facts of one message: human rows
// and typed agent rows, users first (each in insertion order).
func (s *Store) mentionsOf(ctx context.Context, ex channel.Executor, messageID string) ([]Mention, error) {
	out, err := s.mentionsOfTx(ctx, ex, messageID)
	if err != nil {
		return nil, err
	}
	return out.combined(), nil
}

// mentionsOfTx loads the split mention facts of one message.
func (s *Store) mentionsOfTx(ctx context.Context, ex channel.Executor, messageID string) (*resolvedMentions, error) {
	out := &resolvedMentions{}
	rows, err := ex.QueryContext(ctx, `SELECT mm.user_id, u.name FROM message_mentions mm
		JOIN users u ON u.id = mm.user_id
		WHERE mm.message_id = ? ORDER BY mm.rowid`, messageID)
	if err != nil {
		return nil, fmt.Errorf("mention read: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var m Mention
		if err := rows.Scan(&m.ID, &m.Name); err != nil {
			return nil, err
		}
		m.Type = "user"
		out.users = append(out.users, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	agentRows, err := ex.QueryContext(ctx, `SELECT agent_id, handle_at_send FROM message_agent_mentions
		WHERE message_id = ? ORDER BY rowid`, messageID)
	if err != nil {
		// A pre-0014 schema has no agent fact table; with the M4 scope no
		// agent mention can exist, so the read degrades to the human facts
		// instead of failing every human replay.
		if isMissingTable(err) {
			return out, nil
		}
		return nil, fmt.Errorf("agent mention read: %w", err)
	}
	defer agentRows.Close()
	for agentRows.Next() {
		var m Mention
		if err := agentRows.Scan(&m.ID, &m.Name); err != nil {
			return nil, err
		}
		m.Type = "agent"
		out.agents = append(out.agents, m)
	}
	return out, agentRows.Err()
}

// isMissingTable answers a SQLite "no such table" driver error (a pre-0014
// schema simply has no agent mention facts).
func isMissingTable(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no such table")
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
