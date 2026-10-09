// M5 agent messaging use cases: the typed SendAgent send, the writable
// target-DSL resolution and the wiring seams to the delivery (A) and
// agent-lifecycle (C) workers. Everything an agent sends commits in ONE
// shared write transaction whose FIRST step revalidates the agent principal
// through the C-owned validator (the slow credential hash stays at the HTTP
// entry); nothing here writes another domain's tables directly.
package messaging

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/delivery"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
)

// DeliveryPlanner is the delivery worker's transaction-bound planning seam
// (docs/m5-delivery-worker-contract.md §2.2): A's *delivery.Store satisfies
// it directly. ChannelID is the message's OWN channel (the thread channel
// for a reply), never a re-mapped root.
type DeliveryPlanner interface {
	PlanMessageTx(ctx context.Context, tx *sql.Tx, input delivery.PlanInput) error
}

// Compile-time proof that the delivered worker implementations satisfy the
// seams natively (no adapter shims): A's *delivery.Store plans, C's
// *agent.Store revalidates principals.
var (
	_ DeliveryPlanner         = (*delivery.Store)(nil)
	_ AgentPrincipalValidator = (*agent.Store)(nil)
)

// AgentPrincipalValidator is the agent worker's transaction-bound principal
// revalidation seam (docs/m5-lifecycle-worker-contract.md): C's *agent.Store
// satisfies it directly. Inside the caller's transaction/snapshot it
// re-checks the credential is not revoked, its CURRENT stored scopes carry
// the capability, the agent and workspace are live, and the binding is
// consistent. It must not run slow hashes — those belong to the HTTP entry
// that produced the CredentialLookup.
type AgentPrincipalValidator interface {
	ValidateAgentPrincipalTx(ctx context.Context, ex platformdb.Executor, principal agent.CredentialLookup, capability string) error
}

// Agent messaging sentinel outcomes (the transport adapter maps them).
var (
	// ErrAgentTargetNotFound: the target DSL names no conversation visible to
	// the acting agent (the adapter renders the original not-found sentence
	// for the target's shape).
	ErrAgentTargetNotFound = errors.New("agent target not found")
	// ErrAgentTargetShape: the target string is not a usable DSL reference.
	ErrAgentTargetShape = errors.New("target is required")
)

// AgentTargetForbidden: the target resolves but the agent may not POST there
// (no roster row on an ordinary channel, a hidden #all, ...). The adapter
// picks the original forbidden sentence from the target shape.
type AgentTargetForbidden struct{ Target string }

func (e *AgentTargetForbidden) Error() string { return "agent cannot post to this target" }

// AgentTargetPeerNotFound: a dm:@peer reference whose peer names neither a
// workspace human nor a live agent.
type AgentTargetPeerNotFound struct{ Peer string }

func (e *AgentTargetPeerNotFound) Error() string {
	return "User or agent not found: @" + e.Peer
}

// AgentTargetSelfDM: the agent addressed dm:@<its own handle>.
type AgentTargetSelfDM struct{}

func (AgentTargetSelfDM) Error() string { return "Cannot create a DM with yourself" }

// AgentTargetUnsupported: the reference names a real capability this stage
// does not serve (agent-to-agent DM). Honest refusal, never a fake success.
type AgentTargetUnsupported struct{ Reason string }

func (e *AgentTargetUnsupported) Error() string { return e.Reason }

// AgentTarget mirrors the channel-domain resolved reference for the callers
// of ResolveAgentTarget.
type AgentTarget struct {
	ChannelID   string
	ChannelType string
}

// planAgentDeliveriesTx records the mandatory receipt intents for one
// committed message in the SAME transaction: the resolved typed agent
// mentions plus, when the root conversation is a canonical human-Agent DM,
// the DM peer agent (the frozen implicit-receipt rule). Targets are
// de-duplicated and sorted; a replay never calls this (the caller checks).
func (s *Service) planAgentDeliveriesTx(ctx context.Context, tx *sql.Tx, workspaceID string, created *message.CreateResult) error {
	if created == nil || created.Message == nil {
		return nil
	}
	targets := map[string]bool{}
	for _, id := range created.AgentMentionIDs() {
		targets[id] = true
	}
	if created.RootChannelID != "" {
		agentID, ok, err := s.channels.AgentDMParticipantTx(ctx, tx, workspaceID, created.RootChannelID)
		if err != nil {
			return err
		}
		if ok {
			targets[agentID] = true
		}
	}
	if len(targets) == 0 {
		return nil
	}
	ids := make([]string, 0, len(targets))
	for id := range targets {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return s.delivery.PlanMessageTx(ctx, tx, delivery.PlanInput{
		WorkspaceID: workspaceID,
		MessageID:   created.Message.ID,
		ChannelID:   created.Message.ChannelID,
		AgentIDs:    ids,
	})
}

// SendAgent is the ONLY complete agent send entry (docs/m5-execution-lock.md
// §5): transaction-bound principal revalidation via the agent-owned
// validator, agent conversation posting authority, agent-scoped randomId
// idempotency (the original agent idempotencyKey bound of 256 units),
// human mention resolution, the sender_type='agent' message fact and the
// publication intents — all in ONE write transaction. An agent reply never
// advances a human read frontier and never creates an agent receipt intent
// (no cascades). A randomId replay returns the original message without
// re-following or emitting any new publication.
func (s *Service) SendAgent(ctx context.Context, principal agent.CredentialLookup, input message.CreateInput) (*message.CreateResult, error) {
	if principal.AgentID == "" || principal.WorkspaceID == "" {
		return nil, agent.ErrTokenInvalid
	}
	var result *message.CreateResult
	err := platformdb.WithWriteTx(ctx, s.messages.DB(), func(tx *sql.Tx) error {
		if err := s.principals.ValidateAgentPrincipalTx(ctx, tx, principal, "send"); err != nil {
			return err
		}
		created, err := s.messages.CreateAgentMessageTx(ctx, tx, principal.AgentID, principal.WorkspaceID, input)
		if err != nil {
			return err
		}
		if err := s.messages.RecordSendPublicationsTx(ctx, tx, principal.WorkspaceID, created); err != nil {
			return err
		}
		result = created
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// ResolveAgentTarget resolves one WRITABLE target DSL reference (`#channel`,
// `#channel:shortid`, `dm:@peer`, `dm:@peer:shortid`; legacy uppercase DM:@
// included) for the acting agent into the stable channel UUID, porting the
// original resolveWritableAgentTarget semantics:
//
//   - dm:@peer resolves the EXISTING canonical human-Agent DM; when the peer
//     is a workspace human with no conversation yet, the canonical DM is
//     CREATED in this transaction (the original findOrCreateDM path); a peer
//     that names nobody is AgentTargetPeerNotFound, the agent's own handle
//     is AgentTargetSelfDM, and an agent peer is the honest
//     AgentTargetUnsupported (agent-to-agent DM is out of the M5 slice).
//   - #name:shortid / dm:@peer:shortid resolve the parent conversation, then
//     the thread of the parent message whose UUID carries that short id —
//     creating the thread when the parent exists and the agent may post in
//     the parent (announcement threads stay forbidden).
//   - #name resolves the channel (private/joint stay roster-gated) and then
//     enforces posting authority; a resolvable-but-not-postable target is
//     AgentTargetForbidden; an archived one returns the archived conflict.
//
// The whole resolution runs on ONE write transaction after the principal
// revalidation (creation and authority must see the same facts the send
// will commit against). Nothing is implicitly acknowledged.
func (s *Service) ResolveAgentTarget(ctx context.Context, principal agent.CredentialLookup, target string) (*AgentTarget, error) {
	if principal.AgentID == "" || principal.WorkspaceID == "" {
		return nil, agent.ErrTokenInvalid
	}
	ref := strings.TrimSpace(target)
	if ref == "" {
		return nil, ErrAgentTargetShape
	}
	var resolved *channel.AgentTarget
	err := platformdb.WithWriteTx(ctx, s.channels.DB(), func(tx *sql.Tx) error {
		if err := s.principals.ValidateAgentPrincipalTx(ctx, tx, principal, "send"); err != nil {
			return err
		}
		found, err := s.resolveWritableAgentTargetTx(ctx, tx, principal, ref)
		if err != nil {
			return err
		}
		resolved = found
		return nil
	})
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, &AgentTargetNotFound{Target: ref}
	}
	return &AgentTarget{ChannelID: resolved.ChannelID, ChannelType: resolved.ChannelType}, nil
}

// AgentTargetNotFound refines the generic not-found outcome with the
// original reference (the adapter renders the shape-specific sentence).
type AgentTargetNotFound struct{ Target string }

func (e *AgentTargetNotFound) Error() string { return "Channel not found: " + e.Target }

// resolveWritableAgentTargetTx is the transaction-bound writable resolution
// (nil, nil = not found).
func (s *Service) resolveWritableAgentTargetTx(ctx context.Context, tx *sql.Tx, principal agent.CredentialLookup, ref string) (*channel.AgentTarget, error) {
	ws, agentID := principal.WorkspaceID, principal.AgentID
	base, threadShortID := channel.ParseAgentTargetRef(ref)

	if threadShortID != "" {
		parent, err := s.channels.ResolveAgentTargetParentTx(ctx, tx, ws, agentID, base)
		if err != nil {
			return nil, err
		}
		if parent == nil {
			return nil, nil
		}
		thread, err := s.channels.ThreadByParentShortIDTx(ctx, tx, ws, parent.ID, threadShortID)
		if err != nil {
			return nil, err
		}
		if thread == nil {
			// The original creates the thread when the parent message exists
			// in the parent conversation and the agent may post there.
			parentMessageID, err := s.channels.ParentMessageByShortIDTx(ctx, tx, ws, parent.ID, threadShortID)
			if err != nil {
				return nil, err
			}
			if parentMessageID == "" {
				return nil, nil
			}
			if _, err := s.channels.AuthorizeAgentConversationTx(ctx, tx, ws, parent.ID, agentID, true); err != nil {
				return nil, mapAgentTargetAuthorityError(err, ref)
			}
			ensured, err := s.channels.EnsureAgentThreadTx(ctx, tx, ws, parent.ID, parentMessageID)
			if err != nil {
				return nil, err
			}
			// The messages.thread_id projection is message-owned: attach it
			// on this same transaction.
			if err := s.messages.AttachThreadToParentTx(ctx, tx, parentMessageID, ensured.ID); err != nil {
				return nil, err
			}
			return &channel.AgentTarget{ChannelID: ensured.ID, ChannelType: channel.TypeThread}, nil
		}
		if _, err := s.channels.AuthorizeAgentConversationTx(ctx, tx, ws, thread.ID, agentID, true); err != nil {
			return nil, mapAgentTargetAuthorityError(err, ref)
		}
		return &channel.AgentTarget{ChannelID: thread.ID, ChannelType: thread.Type}, nil
	}

	if strings.HasPrefix(base, "DM:@") || strings.HasPrefix(base, "dm:@") {
		peer := base[4:]
		existing, err := s.channels.ResolveAgentDMByPeerNameTx(ctx, tx, ws, agentID, peer)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			if _, err := s.channels.AuthorizeAgentConversationTx(ctx, tx, ws, existing.ID, agentID, true); err != nil {
				return nil, mapAgentTargetAuthorityError(err, ref)
			}
			return &channel.AgentTarget{ChannelID: existing.ID, ChannelType: existing.Type}, nil
		}
		// No conversation yet: a human peer creates the canonical DM; the
		// agent's own handle is the self-DM refusal; another agent is the
		// honest unsupported capability; nobody is the peer-not-found.
		peerUser, err := s.channels.UserIDByNameTx(ctx, tx, ws, peer)
		if err != nil {
			return nil, err
		}
		if peerUser != "" {
			created, err := s.channels.EnsureAgentDMTx(ctx, tx, ws, peerUser, agentID)
			if err != nil {
				return nil, err
			}
			return &channel.AgentTarget{ChannelID: created.ID, ChannelType: created.Type}, nil
		}
		selfName, err := s.channels.AgentHandleTx(ctx, tx, ws, agentID)
		if err != nil {
			return nil, err
		}
		if peer == selfName {
			return nil, &AgentTargetSelfDM{}
		}
		peerAgent, err := s.channels.AgentIDByNameTx(ctx, tx, ws, peer)
		if err != nil {
			return nil, err
		}
		if peerAgent == "" {
			return nil, &AgentTargetPeerNotFound{Peer: peer}
		}
		return nil, &AgentTargetUnsupported{Reason: "Agent-to-agent direct messages are not enabled in this server stage"}
	}

	if strings.HasPrefix(base, "#") {
		found, err := s.channels.ResolveAgentTargetRefTx(ctx, tx, ws, agentID, "#"+base[1:])
		if err != nil {
			return nil, err
		}
		if found == nil {
			return nil, nil
		}
		if _, err := s.channels.AuthorizeAgentConversationTx(ctx, tx, ws, found.ChannelID, agentID, true); err != nil {
			return nil, mapAgentTargetAuthorityError(err, ref)
		}
		return found, nil
	}
	return nil, nil
}

// mapAgentTargetAuthorityError normalizes a channel authorization refusal
// into the typed target outcomes (forbidden vs archived conflict); anything
// else is infrastructure.
func mapAgentTargetAuthorityError(err error, target string) error {
	de := channel.AsDomainError(err)
	if de == nil {
		return err
	}
	switch {
	case de.Code == channel.CodeConflict:
		return message.ErrChannelArchived
	case de.Code == channel.CodeForbidden, de.Code == channel.CodeNotFound:
		return &AgentTargetForbidden{Target: target}
	default:
		return err
	}
}
