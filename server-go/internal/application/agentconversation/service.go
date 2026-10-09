// Package agentconversation is the M5 agent-facing read service: it composes
// the agent-owned credential revalidation (worker C), the channel-owned agent
// conversation authority (worker B) and the message-owned agent reads
// (worker B) into the authorized history window and the message-facts
// projection the delivery dispatcher and the claim inbox render from.
// Writable target creation stays on the messaging use case.
//
// Every entry runs the credential validation and the conversation authority
// on the SAME pinned read snapshot it resolves facts on (never a lookup
// followed by a blind read), and nothing here writes: the only writers stay
// the messaging send use case and the delivery store.
package agentconversation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
)

// Sentinel read failures. The transport adapter (agentapi/domain_adapter.go,
// owned by the integration worker) maps these onto the frozen HTTP bodies;
// no sentence lives here so the domain taxonomy cannot drift from the wire.
var (
	// ErrTargetNotFound: the reference names no conversation this agent may
	// act on (missing, invisible, cross-workspace or a thread that does not
	// exist). The adapter renders the original not-found sentences.
	ErrTargetNotFound = errors.New("agentconversation: target not found")
	// ErrTargetPeerNotFound: a dm:@peer reference whose peer name resolves to
	// no human or agent of this workspace (the directory distinction the
	// original 404 "User or agent not found" needs).
	ErrTargetPeerNotFound = errors.New("agentconversation: dm peer not found")
	// ErrTargetSelfDM: the agent named itself as the DM peer.
	ErrTargetSelfDM = errors.New("agentconversation: cannot create a DM with yourself")
	// ErrTargetForbidden: the reference resolved but the agent may not post.
	ErrTargetForbidden = errors.New("agentconversation: agent may not post in this target")
	// ErrHistoryChannelHidden: the neutral hidden-channel answer shared by
	// "does not exist" and "no prior relationship" (anti-oracle).
	ErrHistoryChannelHidden = errors.New("agentconversation: channel not found or not visible")
	// ErrHistoryForbidden: visible channel, no read access.
	ErrHistoryForbidden = errors.New("agentconversation: no access to this history")
)

// AnchorError is one before/after/around anchor that failed to resolve to a
// message position. Reason mirrors the original payload set: invalid |
// ambiguous | not_found.
type AnchorError struct {
	Reason  string
	Anchor  string
	Channel string
}

func (e *AnchorError) Error() string {
	return fmt.Sprintf("agentconversation: anchor %s (%s) in %s", e.Anchor, e.Reason, e.Channel)
}

// ResolvedTarget is a writable-target fact: the stable channel UUID plus the
// agent-facing kind the transport reports.
type ResolvedTarget struct {
	ChannelID   string
	ChannelType string
}

// HistoryQuery is one authorized history window request. ChannelRef carries
// the original CLI target DSL verbatim; the anchors keep their raw text (the
// handler has already shape-checked them); Limit is clamped by the handler.
type HistoryQuery struct {
	ChannelRef string
	Before     string
	After      string
	Around     string
	Limit      int64
}

// Service owns no facts: it validates construction inputs and then composes
// the three fact owners on shared snapshots. All fields are frozen at
// construction; there is no post-construction setter.
type Service struct {
	agents   *agent.Store
	channels *channel.Store
	messages *message.Store
}

// NewService validates the fact owners share one database and freezes them.
func NewService(agents *agent.Store, channels *channel.Store, messages *message.Store) (*Service, error) {
	if agents == nil || channels == nil || messages == nil {
		return nil, errors.New("agentconversation: agent, channel and message fact owners are required")
	}
	// The channel and message stores expose their owning handle, so the
	// shared-database invariant is checkable here; the agent store has no DB
	// accessor by design and the composition root constructs all three on one
	// handle (its ownership check covers the agent side).
	if channels.DB() == nil || messages.DB() == nil || messages.DB() != channels.DB() {
		return nil, errors.New("agentconversation: channel and message fact owners must share one application database")
	}
	return &Service{agents: agents, channels: channels, messages: messages}, nil
}

// AuthorizeDeliveryTx requires the same current read AND reply authority as
// the original mention plan. Historical public reads can remain allowed after
// a roster removal or archive; that is not authority to receive a new input.
// Retry, claim, ACK and final enqueue all use this seam on their own pinned
// transaction/fence. History keeps its separate read-only authorization.
func (s *Service) AuthorizeDeliveryTx(ctx context.Context, ex platformdb.Executor, workspaceID, channelID, agentID string) (*channel.Conversation, error) {
	return s.channels.AuthorizeAgentConversationTx(ctx, ex, workspaceID, channelID, agentID, true)
}

// ValidatePrincipalTx revalidates the sk_agent_* credential, binding and
// capability on the caller's executor (C's transaction-bound validator). It
// is the seam the delivery claim/ack adapter shares with the read exits so
// every agent-facing surface revalidates the SAME way.
func (s *Service) ValidatePrincipalTx(ctx context.Context, ex platformdb.Executor, principal agent.CredentialLookup, capability string) error {
	return s.agents.ValidateAgentPrincipalTx(ctx, ex, principal, capability)
}

// WritableByChannelID authorizes a channelId:<uuid> send target. Named DSL
// forms stay on the messaging use case, which creates DMs and threads. This
// form is the stable id the CLI echoes as reply_target; it creates nothing.
func (s *Service) WritableByChannelID(ctx context.Context, principal agent.CredentialLookup, channelID string) (*channel.Conversation, error) {
	if principal.AgentID == "" || principal.WorkspaceID == "" {
		return nil, agent.ErrTokenInvalid
	}
	if channelID == "" {
		return nil, ErrTargetNotFound
	}
	var conv *channel.Conversation
	err := platformdb.WithWriteTx(ctx, s.channels.DB(), func(tx *sql.Tx) error {
		if err := s.ValidatePrincipalTx(ctx, tx, principal, "send"); err != nil {
			return err
		}
		found, err := s.channels.AuthorizeAgentConversationTx(ctx, tx, principal.WorkspaceID, channelID, principal.AgentID, true)
		if err != nil {
			return err
		}
		conv = found
		return nil
	})
	if err != nil {
		return nil, err
	}
	if conv == nil || conv.Channel == nil {
		return nil, ErrTargetNotFound
	}
	return conv, nil
}

func channelIDRef(ref string) (string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(ref), "channelId:")
	if !ok {
		return "", false
	}
	rest = strings.TrimSpace(rest)
	if rest == "" || strings.Contains(rest, ":") {
		return "", false
	}
	return rest, true
}

// Writable target creation (canonical Agent DM, thread ensure) is the
// messaging use case. This package only authorizes and reads.

func isShortID(v string) bool {
	if len(v) != 8 {
		return false
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// historyWindow carries the anchor resolutions of one ReadHistory call out
// of its snapshot closure.
type historyWindow struct {
	channelID string
	before    *int64
	after     *int64
	around    *int64
}

// ReadHistory serves one authorized history window. The credential check and
// the reference resolution share one pinned snapshot; the message window
// itself is read through B's agent-authorized page/context reads (each of
// which re-runs the conversation authority on its own snapshot, so a
// revocation between the two snapshots still fails closed). Anchors resolve
// to a seq position first; a plain latest/before/after page then runs
// through B's page read. Agents carry no readstate in this stage, so the
// last-read cursor stays absent (never fabricated).
func (s *Service) ReadHistory(ctx context.Context, principal agent.CredentialLookup, q HistoryQuery) (*HistoryFacts, error) {
	if principal.AgentID == "" || principal.WorkspaceID == "" {
		return nil, agent.ErrTokenInvalid
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	channelRef := strings.TrimSpace(q.ChannelRef)

	var window historyWindow
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		if err := s.ValidatePrincipalTx(ctx, ex, principal, "read"); err != nil {
			return err
		}
		var found *channel.AgentTarget
		if channelID, ok := channelIDRef(channelRef); ok {
			found = &channel.AgentTarget{ChannelID: channelID}
		} else {
			resolved, err := s.channels.ResolveAgentTargetRefTx(ctx, ex, principal.WorkspaceID, principal.AgentID, channelRef)
			if err != nil {
				return err
			}
			found = resolved
		}
		if found == nil {
			return ErrHistoryChannelHidden
		}
		// Read authority (hidden roots already failed above; the remaining
		// explicit denial class is the original 403).
		if _, err := s.channels.AuthorizeAgentConversationTx(ctx, ex, principal.WorkspaceID, found.ChannelID, principal.AgentID, false); err != nil {
			if de := channel.AsDomainError(err); de != nil {
				switch de.Code {
				case channel.CodeForbidden:
					return ErrHistoryForbidden
				case channel.CodeNotFound:
					return ErrHistoryChannelHidden
				}
			}
			return err
		}
		window.channelID = found.ChannelID
		for _, anchor := range []struct {
			raw  string
			dest **int64
		}{{q.Before, &window.before}, {q.After, &window.after}} {
			if strings.TrimSpace(anchor.raw) == "" {
				continue
			}
			seq, err := s.resolveAnchor(ctx, ex, principal.WorkspaceID, found.ChannelID, channelRef, strings.TrimSpace(anchor.raw))
			if err != nil {
				return err
			}
			*anchor.dest = &seq
		}
		if strings.TrimSpace(q.Around) != "" {
			seq, err := s.resolveAnchor(ctx, ex, principal.WorkspaceID, found.ChannelID, channelRef, strings.TrimSpace(q.Around))
			if err != nil {
				return err
			}
			window.around = &seq
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	if window.around != nil {
		return s.aroundWindow(ctx, principal, window.channelID, *window.around, limit)
	}
	page, err := s.messages.ListAgentChannelPageForAgent(ctx, principal.WorkspaceID, window.channelID, principal.AgentID, message.PageQuery{
		Limit:  int(limit),
		Before: window.before,
		After:  window.after,
	})
	if err != nil {
		return nil, err
	}
	facts := &HistoryFacts{Messages: []MessageFacts{}}
	for i, msg := range page.Messages {
		var proj *message.Projection
		if i < len(page.Projections) {
			proj = page.Projections[i]
		}
		fact, err := s.factsForMessage(ctx, principal.WorkspaceID, principal.AgentID, msg, proj, page.ThreadSummaries)
		if err != nil {
			return nil, err
		}
		facts.Messages = append(facts.Messages, fact)
	}
	facts.HasNewer = page.Coverage.HasNewer
	facts.HasOlder = page.Coverage.HasGap && page.Coverage.CoveredFromSeq > 0
	if window.after != nil {
		// An after-window always has older rows by construction (the anchor
		// itself is older); report that honestly.
		facts.HasOlder = true
	}
	return facts, nil
}

// resolveAnchor resolves one anchor text (decimal seq | 8-hex short id |
// full UUID) to the message's seq position inside the channel, on the
// caller's snapshot. The short-id prefix lookup is a narrow message-fact
// read scoped to (workspace, channel, id prefix) with the original
// zero/one/many ambiguity rule.
func (s *Service) resolveAnchor(ctx context.Context, ex platformdb.Executor, workspaceID, channelID, channelRef, anchor string) (int64, error) {
	if seq, err := strconv.ParseInt(anchor, 10, 64); err == nil && seq >= 0 {
		return seq, nil
	}
	if isUUID(anchor) {
		var seq int64
		err := ex.QueryRowContext(ctx, `SELECT seq FROM messages WHERE workspace_id = ? AND channel_id = ? AND id = ?`,
			workspaceID, channelID, anchor).Scan(&seq)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, &AnchorError{Reason: "not_found", Anchor: anchor, Channel: channelRef}
		}
		if err != nil {
			return 0, fmt.Errorf("resolve anchor uuid: %w", err)
		}
		return seq, nil
	}
	if !isShortID(anchor) {
		return 0, &AnchorError{Reason: "invalid", Anchor: anchor, Channel: channelRef}
	}
	rows, err := ex.QueryContext(ctx, `SELECT seq FROM messages WHERE workspace_id = ? AND channel_id = ? AND substr(id, 1, 8) = ? LIMIT 2`,
		workspaceID, channelID, strings.ToLower(anchor))
	if err != nil {
		return 0, fmt.Errorf("resolve anchor short id: %w", err)
	}
	defer rows.Close()
	var seqs []int64
	for rows.Next() {
		var seq int64
		if err := rows.Scan(&seq); err != nil {
			return 0, err
		}
		seqs = append(seqs, seq)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	switch len(seqs) {
	case 1:
		return seqs[0], nil
	case 0:
		return 0, &AnchorError{Reason: "not_found", Anchor: anchor, Channel: channelRef}
	default:
		return 0, &AnchorError{Reason: "ambiguous", Anchor: anchor, Channel: channelRef}
	}
}

// aroundWindow renders the --around window through B's agent-authorized
// context read (beforeCount/afterCount split exactly like the original).
func (s *Service) aroundWindow(ctx context.Context, principal agent.CredentialLookup, channelID string, seq int64, limit int64) (*HistoryFacts, error) {
	messageID, err := s.messageIDAtSeq(ctx, principal.WorkspaceID, channelID, seq)
	if err != nil || messageID == "" {
		return nil, err
	}
	before := int((limit - 1) / 2)
	after := int(limit) - before - 1
	if after < 0 {
		after = 0
	}
	result, err := s.messages.GetAgentMessageContextForAgent(ctx, principal.WorkspaceID, channelID, messageID, principal.AgentID, before, after)
	if err != nil {
		if errors.Is(err, message.ErrMessageNotFound) {
			return nil, ErrHistoryChannelHidden
		}
		return nil, err
	}
	facts := &HistoryFacts{Messages: []MessageFacts{}}
	for i, msg := range result.Messages {
		var proj *message.Projection
		if i < len(result.Projections) {
			proj = result.Projections[i]
		}
		fact, err := s.factsForMessage(ctx, principal.WorkspaceID, principal.AgentID, msg, proj, result.ThreadSummaries)
		if err != nil {
			return nil, err
		}
		facts.Messages = append(facts.Messages, fact)
	}
	facts.HasOlder = result.HasOlder
	facts.HasNewer = result.HasNewer
	return facts, nil
}

// messageIDAtSeq locates the channel row at one seq position (the around
// anchor enters B's context read by id). Read-only, snapshot-pinned.
func (s *Service) messageIDAtSeq(ctx context.Context, workspaceID, channelID string, seq int64) (string, error) {
	var id string
	err := platformdb.WithReadSnapshot(ctx, s.messages.DB(), func(ex platformdb.Executor) error {
		return ex.QueryRowContext(ctx, `SELECT id FROM messages WHERE workspace_id = ? AND channel_id = ? AND seq = ?`,
			workspaceID, channelID, seq).Scan(&id)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("locate anchor row: %w", err)
	}
	return id, nil
}

// MessageFacts projects one message (authorized for the agent viewer through
// B's agent context read) into the transport-neutral facts the presenter
// turns into the AgentMessage wire envelope. The delivery dispatcher uses it
// for the agent:deliver body. Callers that already hold the claim transaction
// use MessageFactsTx so the read stays on that executor.
func (s *Service) MessageFacts(ctx context.Context, workspaceID, channelID, messageID, agentID string) (MessageFacts, error) {
	var facts MessageFacts
	err := platformdb.WithReadSnapshot(ctx, s.messages.DB(), func(ex platformdb.Executor) error {
		var err error
		facts, err = s.MessageFactsTx(ctx, ex, workspaceID, channelID, messageID, agentID)
		return err
	})
	if err != nil {
		return MessageFacts{}, err
	}
	return facts, nil
}

// MessageFactsTx projects one message on the caller's executor. It does not
// open WithWriteTx or WithReadSnapshot. A caller that accepted a credential
// must already have validated that principal on ex; this method re-checks
// conversation read authority on that same executor and fails closed when
// the row is missing or not in the named channel.
func (s *Service) MessageFactsTx(ctx context.Context, ex platformdb.Executor, workspaceID, channelID, messageID, agentID string) (MessageFacts, error) {
	if ex == nil {
		return MessageFacts{}, errors.New("agentconversation: message facts require an executor")
	}
	result, err := s.messages.GetAgentMessageContextForAgentTx(ctx, ex, workspaceID, channelID, messageID, agentID, 0, 0)
	if err != nil {
		return MessageFacts{}, err
	}
	if result == nil || len(result.Messages) == 0 || result.Messages[0] == nil {
		return MessageFacts{}, message.ErrMessageNotFound
	}
	var proj *message.Projection
	if len(result.Projections) > 0 {
		proj = result.Projections[0]
	}
	return s.factsForMessageTx(ctx, ex, workspaceID, agentID, result.Messages[0], proj, result.ThreadSummaries)
}

// ChannelSnapshot is the conversation naming for one agent-visible channel,
// read on the caller's executor. Parent fields are set only for a thread.
type ChannelSnapshot struct {
	ChannelID         string
	ChannelName       string
	ChannelType       string
	ParentChannelName *string
	ParentChannelType *string
}

// ChannelSnapshotTx reads the channel names that own a message projection.
// It does not open a nested snapshot. Hidden or unauthorized conversations
// fail closed through the channel authority.
func (s *Service) ChannelSnapshotTx(ctx context.Context, ex platformdb.Executor, workspaceID, channelID, agentID string) (ChannelSnapshot, error) {
	if ex == nil {
		return ChannelSnapshot{}, errors.New("agentconversation: channel snapshot requires an executor")
	}
	conv, err := s.channels.AuthorizeAgentConversationTx(ctx, ex, workspaceID, channelID, agentID, false)
	if err != nil {
		return ChannelSnapshot{}, err
	}
	if conv == nil || conv.Channel == nil {
		return ChannelSnapshot{}, ErrHistoryChannelHidden
	}
	snap := ChannelSnapshot{
		ChannelID:   conv.Channel.ID,
		ChannelName: conv.Channel.Name,
		ChannelType: conv.Channel.Type,
	}
	if conv.Channel.Type == channel.TypeThread && conv.Root != nil && conv.Root != conv.Channel {
		name := conv.Root.Name
		parentType := conv.Root.Type
		snap.ParentChannelName = &name
		snap.ParentChannelType = &parentType
	}
	return snap, nil
}

// factsForMessage enriches one message row + projection with the channel
// naming facts (thread channels keep their storage name "thread-<shortid>";
// the parent fields come from the authorized root conversation) and the
// viewer's typed-mention fact.
func (s *Service) factsForMessage(ctx context.Context, workspaceID, agentID string, msg *message.Message, proj *message.Projection, summaries map[string]channel.ThreadSummary) (MessageFacts, error) {
	var facts MessageFacts
	err := platformdb.WithReadSnapshot(ctx, s.channels.DB(), func(ex platformdb.Executor) error {
		var err error
		facts, err = s.factsForMessageTx(ctx, ex, workspaceID, agentID, msg, proj, summaries)
		return err
	})
	if err != nil {
		return MessageFacts{}, err
	}
	return facts, nil
}

func (s *Service) factsForMessageTx(ctx context.Context, ex platformdb.Executor, workspaceID, agentID string, msg *message.Message, proj *message.Projection, summaries map[string]channel.ThreadSummary) (MessageFacts, error) {
	facts := MessageFacts{
		Seq:         msg.Seq,
		MessageID:   msg.ID,
		TimestampMS: msg.CreatedAtUnix,
		Content:     msg.Content,
		ThreadID:    msg.ThreadID,
	}
	if proj != nil {
		facts.SenderName = proj.SenderName
		facts.SenderDescription = proj.SenderDescription
	}
	facts.SenderType = agentFacingSenderType(msg)
	snap, err := s.ChannelSnapshotTx(ctx, ex, workspaceID, msg.ChannelID, agentID)
	if err != nil {
		return MessageFacts{}, err
	}
	facts.ChannelID = snap.ChannelID
	facts.ChannelName = snap.ChannelName
	facts.ChannelType = snap.ChannelType
	facts.ParentChannelName = snap.ParentChannelName
	facts.ParentChannelType = snap.ParentChannelType
	// The viewer's own typed-mention fact (agent mentions live in their
	// own table; a DM implicit receipt is not a mention).
	var one int
	err = ex.QueryRowContext(ctx,
		`SELECT 1 FROM message_agent_mentions WHERE message_id = ? AND agent_id = ?`,
		msg.ID, agentID).Scan(&one)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return MessageFacts{}, fmt.Errorf("read viewer mention fact: %w", err)
	}
	facts.Mentioned = err == nil
	if summary, ok := summaries[msg.ID]; ok {
		count := int64(summary.ReplyCount)
		facts.ReplyCount = &count
	}
	return facts, nil
}

// agentFacingSenderType maps the persisted sender vocabulary onto the
// agent-facing envelope set (human | agent | system | third_party_app).
func agentFacingSenderType(msg *message.Message) string {
	switch {
	case msg.MessageType == "system":
		return "system"
	case msg.SenderType == "agent":
		return "agent"
	case msg.SenderType == "user":
		return "human"
	default:
		return "third_party_app"
	}
}

func isUUID(v string) bool {
	if len(v) != 36 {
		return false
	}
	for i, c := range v {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return false
			}
		}
	}
	return true
}
