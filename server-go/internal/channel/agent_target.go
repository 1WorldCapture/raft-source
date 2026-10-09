// M5 target DSL resolution for agent API surfaces: the server is the
// authority that turns `#channel`, `#channel:shortid`, `dm:@peer` and
// `dm:@peer:shortid` (legacy uppercase DM:@ included) into a stable channel
// UUID. Resolution reads real facts; the WRITABLE form additionally enforces
// posting authority, creates the canonical human-Agent DM when the agent
// targets dm:@<human> with no conversation yet, and ensures the unique
// thread of a parent message for thread targets (ported from the original TS
// parseChannelRef / resolveChannelByName / agentWritableTarget).
package channel

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"

	"raft.local/server-go/internal/publication"
)

// AgentTarget is one resolved target DSL reference.
type AgentTarget struct {
	ChannelID   string
	ChannelType string
}

// messageShortIDPattern is the original MESSAGE_SHORT_ID_RE: the thread
// suffix of a target ref must be a full 8-hex message short id (a looser
// pattern would route plain channels whose name contains a colon into
// thread lookup).
var messageShortIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}$`)

// parseAgentTargetRef splits a target into its channel part and optional
// thread short id. The suffix rule lives only here.
func parseAgentTargetRef(ref string) (base, threadShortID string) {
	withSuffix := func(prefix, rest string) (string, string) {
		last := strings.LastIndex(rest, ":")
		if last > 0 && messageShortIDPattern.MatchString(rest[last+1:]) {
			return prefix + rest[:last], rest[last+1:]
		}
		return prefix + rest, ""
	}
	if strings.HasPrefix(ref, "DM:@") || strings.HasPrefix(ref, "dm:@") {
		return withSuffix(ref[:4], ref[4:])
	}
	if strings.HasPrefix(ref, "#") {
		return withSuffix("#", ref[1:])
	}
	return ref, ""
}

// ResolveAgentTargetRefTx resolves one target DSL reference for the acting
// agent on the caller's executor (read-only: nothing is created or revived).
// nil without error means the reference does not name a conversation this
// agent may see.
//
//   - "#name": a live listable channel (channel/private/joint) of this
//     workspace; a hidden #all never resolves; private/joint additionally
//     require the agent roster row.
//   - "#name:shortid" / "dm:@peer:shortid": the live thread channel whose
//     parent message id starts with the 8-hex short id inside the resolved
//     parent conversation (the storage name thread-<shortid> is the
//     projection of exactly this rule).
//   - "dm:@peer": the EXISTING canonical human-Agent DM with the named human
//     peer (typed pair fact; never creates one here).
func (s *Store) ResolveAgentTargetRefTx(ctx context.Context, ex Executor, workspaceID, agentID, ref string) (*AgentTarget, error) {
	base, threadShortID := parseAgentTargetRef(ref)
	if threadShortID != "" {
		parent, err := s.resolveAgentTargetParent(ctx, ex, workspaceID, agentID, base)
		if err != nil || parent == nil {
			return nil, err
		}
		thread, err := s.threadByParentShortID(ctx, ex, workspaceID, parent.ID, threadShortID)
		if err != nil || thread == nil {
			return nil, err
		}
		return &AgentTarget{ChannelID: thread.ID, ChannelType: thread.Type}, nil
	}
	if strings.HasPrefix(base, "DM:@") || strings.HasPrefix(base, "dm:@") {
		channel, err := s.ResolveAgentDMByPeerNameTx(ctx, ex, workspaceID, agentID, base[4:])
		if err != nil || channel == nil {
			return nil, err
		}
		return &AgentTarget{ChannelID: channel.ID, ChannelType: channel.Type}, nil
	}
	if strings.HasPrefix(base, "#") {
		return s.resolveAgentNamedChannel(ctx, ex, workspaceID, agentID, base[1:])
	}
	return nil, nil
}

func (s *Store) resolveAgentNamedChannel(ctx context.Context, ex Executor, workspaceID, agentID, name string) (*AgentTarget, error) {
	var id, channelType string
	err := ex.QueryRowContext(ctx, `
		SELECT id, type FROM channels
		WHERE workspace_id = ? AND name = ? AND type IN (?, ?, ?) AND deleted_at IS NULL`,
		workspaceID, name, TypeChannel, TypePrivate, TypeJoint).Scan(&id, &channelType)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve agent target channel: %w", err)
	}
	if name == systemAllName && channelType != TypeChannel {
		return nil, nil // hidden #all
	}
	if channelType == TypePrivate || channelType == TypeJoint {
		member, err := s.isChannelAgentTx(ctx, ex, id, agentID)
		if err != nil || !member {
			return nil, err
		}
	}
	return &AgentTarget{ChannelID: id, ChannelType: channelType}, nil
}

// resolveAgentTargetParent resolves the parent CONVERSATION of a thread
// target: "#name" (roster-gated for private/joint like the plain form) or
// the existing canonical DM of "dm:@peer". nil means the parent reference
// itself is not visible to the agent.
func (s *Store) resolveAgentTargetParent(ctx context.Context, ex Executor, workspaceID, agentID, base string) (*Channel, error) {
	if strings.HasPrefix(base, "DM:@") || strings.HasPrefix(base, "dm:@") {
		return s.ResolveAgentDMByPeerNameTx(ctx, ex, workspaceID, agentID, base[4:])
	}
	if strings.HasPrefix(base, "#") {
		target, err := s.resolveAgentNamedChannel(ctx, ex, workspaceID, agentID, base[1:])
		if err != nil || target == nil {
			return nil, err
		}
		return s.getChannel(ctx, ex, target.ChannelID, false)
	}
	return nil, nil
}

// threadByParentShortID finds the live thread channel of the parent message
// whose UUID starts with the 8-hex short id inside one parent conversation
// (the thread's storage name thread-<shortid> is exactly this projection;
// the parent-message lookup keeps cross-channel id collisions honest).
func (s *Store) threadByParentShortID(ctx context.Context, ex Executor, workspaceID, parentChannelID, shortID string) (*Channel, error) {
	row := ex.QueryRowContext(ctx, `SELECT `+channelColumns+`
		FROM channels c
		WHERE c.workspace_id = ? AND c.type = ? AND c.name = ? AND c.deleted_at IS NULL`,
		workspaceID, TypeThread, "thread-"+shortID)
	c, err := scanChannel(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read thread by short id: %w", err)
	}
	// The thread must actually hang off this parent conversation (a same
	// short-id prefix collision from another channel must not resolve).
	if c.ParentMessageID == nil || *c.ParentMessageID == "" {
		return nil, nil
	}
	var owner string
	err = ex.QueryRowContext(ctx, `SELECT channel_id FROM messages
		WHERE id = ? AND workspace_id = ?`, *c.ParentMessageID, workspaceID).Scan(&owner)
	if err != nil || owner != parentChannelID {
		return nil, err
	}
	return c, nil
}

// EnsureAgentThreadTx finds or creates the unique thread channel of one
// parent message for an AGENT sender, with the same guards as the human
// ensure: live parent channel of this workspace, no thread nesting, no
// announcement threads, and the parent message really belonging to the
// channel. The partial unique index arbitrates concurrent ensures. The
// agent has no follow facts, so the human author-follow step of the human
// ensure is replaced by nothing. The thread:updated appearance intent is
// emitted on real creation only; the messages.thread_id projection stays
// message-owned (the application use case attaches it in the same commit).
func (s *Store) EnsureAgentThreadTx(ctx context.Context, tx *sql.Tx, workspaceID, channelID, parentMessageID string) (*Channel, error) {
	parent, err := s.getChannel(ctx, tx, channelID, false)
	if err != nil {
		return nil, err
	}
	if parent == nil || parent.WorkspaceID != workspaceID {
		return nil, &DomainError{Code: CodeNotFound, Message: ThreadParentChannelMissing}
	}
	if parent.Type == TypeThread {
		return nil, &DomainError{Code: CodeInvalidInput, Message: ThreadNestedMessage}
	}
	if IsAnnouncementChannel(parent) {
		return nil, &DomainError{Code: CodeInvalidInput, Message: AnnouncementNoThreadsMsg}
	}
	message, err := s.readParentMessage(ctx, tx, parentMessageID)
	if err != nil {
		return nil, err
	}
	if message == nil || message.ChannelID != channelID || message.WorkspaceID != workspaceID {
		return nil, &DomainError{Code: CodeNotFound, Message: ThreadParentMessageMissing}
	}
	thread, created, err := s.insertThreadChannel(ctx, tx, workspaceID, parentMessageID)
	if err != nil {
		return nil, err
	}
	if created {
		// The durable appearance intent of the new thread (revision 1 — a
		// thread can only be created once; soft-deleted threads are not
		// revived by ensure in this phase).
		if err := publication.Enqueue(ctx, tx, publication.Publication{
			WorkspaceID: workspaceID,
			ObjectType:  "channel",
			ObjectID:    thread.ID,
			EventType:   PublicationEventThreadUpdated,
			Revision:    1,
			ScopeID:     thread.ID,
		}); err != nil {
			return nil, err
		}
	}
	return thread, nil
}

// ---------------------------------------------------------------------------
// Exported facts for the messaging application's writable resolution.
// ---------------------------------------------------------------------------

// ParseAgentTargetRef splits one target DSL reference at the exported seam.
func ParseAgentTargetRef(ref string) (base, threadShortID string) {
	return parseAgentTargetRef(ref)
}

// ResolveAgentTargetParentTx resolves the parent CONVERSATION of a thread
// target reference (read-only; nil = the parent ref is invisible).
func (s *Store) ResolveAgentTargetParentTx(ctx context.Context, ex Executor, workspaceID, agentID, base string) (*Channel, error) {
	return s.resolveAgentTargetParent(ctx, ex, workspaceID, agentID, base)
}

// ThreadByParentShortIDTx finds the live thread channel of the parent
// message carrying one 8-hex short id inside the given parent conversation
// (nil = none).
func (s *Store) ThreadByParentShortIDTx(ctx context.Context, ex Executor, workspaceID, parentChannelID, shortID string) (*Channel, error) {
	return s.threadByParentShortID(ctx, ex, workspaceID, parentChannelID, shortID)
}

// ParentMessageByShortIDTx resolves the parent message id whose UUID starts
// with the 8-hex short id inside one conversation. "" means no match; more
// than one match (a corrupted id space) also reads as none, exactly like the
// original's LIMIT 2 ambiguity rule.
func (s *Store) ParentMessageByShortIDTx(ctx context.Context, ex Executor, workspaceID, channelID, shortID string) (string, error) {
	rows, err := ex.QueryContext(ctx, `SELECT id FROM messages
		WHERE workspace_id = ? AND channel_id = ? AND id LIKE ? LIMIT 2`,
		workspaceID, channelID, shortID+"%")
	if err != nil {
		return "", fmt.Errorf("parent message short id lookup: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(ids) != 1 {
		return "", nil
	}
	return ids[0], nil
}

// UserIDByNameTx resolves one workspace HUMAN member by directory handle
// ("" = nobody; the hidden-directory policy does not apply — the target DSL
// carries an exact handle, like the original resolveUserByName).
func (s *Store) UserIDByNameTx(ctx context.Context, ex Executor, workspaceID, name string) (string, error) {
	var id string
	err := ex.QueryRowContext(ctx, `
		SELECT u.id FROM users u
		JOIN workspace_memberships m ON m.user_id = u.id AND m.workspace_id = ?
		WHERE u.name = ? LIMIT 1`, workspaceID, name).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve user by name: %w", err)
	}
	return id, nil
}

// AgentHandleTx reads the stored handle (agents.name) of one agent.
func (s *Store) AgentHandleTx(ctx context.Context, ex Executor, workspaceID, agentID string) (string, error) {
	var name string
	err := ex.QueryRowContext(ctx,
		`SELECT name FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		agentID, workspaceID).Scan(&name)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read agent handle: %w", err)
	}
	return name, nil
}

// AgentIDByNameTx resolves one live agent of the workspace by handle
// ("" = nobody).
func (s *Store) AgentIDByNameTx(ctx context.Context, ex Executor, workspaceID, name string) (string, error) {
	var id string
	err := ex.QueryRowContext(ctx,
		`SELECT id FROM agents WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`,
		workspaceID, name).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve agent by name: %w", err)
	}
	return id, nil
}
