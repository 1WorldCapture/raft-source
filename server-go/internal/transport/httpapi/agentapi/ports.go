// Consumer-side ports for the M5 Agent CLI HTTP surface. The transport owns
// the interface definitions; the fact owners (delivery/messaging/channel/agent
// per the M5 execution lock) provide the implementations and the composition
// root wires them through NewHandlers. Signatures deliberately use only
// primitives and domain types (agent.CredentialLookup, message.CreateInput) so
// a domain implementation never has to import this package. No port performs
// SQL here; every authorization revalidation happens inside the implementing
// domain's own transaction.
package agentapi

import (
	"context"
	"errors"
	"fmt"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/transport/presenter"
)

// ---- send -----------------------------------------------------------------

// AgentSendInput is the normalized request of POST /send and POST /v2/send:
// the target has already been resolved to a stable channel UUID and both
// entries carry the same envelope. The embedded message.CreateInput is the
// locked cross-module creation input; IdempotencyKey carries the CLI
// --idempotency-key (original agent_send_key column, 1..256 chars, "" when
// absent). Mentions are only populated for the v2 typed contract.
type AgentSendInput struct {
	message.CreateInput
	IdempotencyKey string
}

// SendAgentPort is the transactional agent send use case (lock hard-contract
// #5): credential/agent/binding/scope revalidation, shape validation, posting
// authority, idempotency and the message fact all commit atomically inside
// the implementation. A replay returns the original message with Replayed.
type SendAgentPort interface {
	SendAgent(ctx context.Context, principal agent.CredentialLookup, in AgentSendInput) (*message.CreateResult, error)
}

// ---- writable target DSL --------------------------------------------------

// WritableTargetResolution is a resolved writable target: the stable channel
// UUID plus the agent-facing kind ("channel" | "private" | "dm" | "thread").
type WritableTargetResolution struct {
	ChannelID string
	Kind      string
}

// TargetForbiddenError is the 403 branch: the target resolved but the agent
// may not post. Message carries the exact original sentence (announcement /
// thread-not-parent-member / channel-not-member variants from
// routes/agentWritableTarget.ts).
type TargetForbiddenError struct{ Message string }

func (e *TargetForbiddenError) Error() string { return e.Message }

// TargetNotFoundError is the 404 branch for a target that did not resolve.
// Message carries notFoundMessageForTarget's exact sentence (thread variant
// included).
type TargetNotFoundError struct{ Message string }

func (e *TargetNotFoundError) Error() string { return e.Message }

// ErrAgentTargetPeerNotFound maps to 404 "User or agent not found: @<peer>"
// for a dm:@peer whose peer exists in no directory.
var ErrAgentTargetPeerNotFound = errors.New("agent api: dm peer not found")

// ErrAgentTargetSelfDM maps to 400 "Cannot create a DM with yourself".
var ErrAgentTargetSelfDM = errors.New("agent api: cannot create a DM with yourself")

// AgentDMNotEnabledError is the honest 501 for agent-peer DM creation while
// the typed Agent DM slice (S6) is not implemented: never a fake channel.
type AgentDMNotEnabledError struct{ Message string }

func (e *AgentDMNotEnabledError) Error() string { return e.Message }

// WritableTargetPort resolves the agent target DSL (#channel, dm:@peer,
// #channel:shortid, dm:@peer:shortid) to a stable channel UUID with posting
// authority. The send use case revalidates posting inside its own
// transaction, so this resolution only narrows the address.
type WritableTargetPort interface {
	ResolveWritableAgentTarget(ctx context.Context, principal agent.CredentialLookup, target string) (*WritableTargetResolution, error)
}

// ---- history --------------------------------------------------------------

// AgentHistoryQuery is one authorized history read: the raw channel ref plus
// optional anchors (a decimal seq, an 8-hex short id or a full UUID — the
// handler has already shape-checked them) and a clamped limit (1..100,
// default 50). Exactly one of Before/After/Around is set at most.
type AgentHistoryQuery struct {
	ChannelRef string
	Before     string
	After      string
	Around     string
	Limit      int64
}

// History anchor failure reasons, mirroring the TS payload set.
const (
	HistoryAnchorInvalid   = "invalid"
	HistoryAnchorAmbiguous = "ambiguous"
	HistoryAnchorNotFound  = "not_found"
)

// HistoryAnchorError is the before/after/around anchor failure. The handler
// renders the exact original body: 400 INVALID_ARG (invalid), 400
// AMBIGUOUS_ID (+suggestedNextAction) or 404 NOT_FOUND — keyed errorCode.
type HistoryAnchorError struct {
	Reason     string
	ChannelRef string
	Anchor     string
}

func (e *HistoryAnchorError) Error() string {
	return fmt.Sprintf("history anchor %s in %s: %s", e.Reason, e.ChannelRef, e.Anchor)
}

// HistoryChannelHiddenError maps to the neutral 404 shared by "does not
// exist" and "no prior relationship" (anti-oracle constant body).
var HistoryChannelHiddenError = errors.New("agent api: channel not found or not visible")

// HistoryForbiddenError maps to 403 "You do not have access to this history".
var HistoryForbiddenError = errors.New("agent api: no access to this history")

// HistoryNotFoundError carries a typed 404 body with the original sentence
// (e.g. the thread-without-replies message with its suggestedNextAction).
type HistoryNotFoundError struct {
	Message             string
	Code                string
	SuggestedNextAction string
}

func (e *HistoryNotFoundError) Error() string { return e.Message }

// AgentHistoryPort reads one authorized history window for the authenticated
// agent. Read-only: it never advances a delivery ACK or fabricates cursors.
type AgentHistoryPort interface {
	ReadAgentHistory(ctx context.Context, principal agent.CredentialLookup, q AgentHistoryQuery) (*presenter.AgentHistoryFacts, error)
}

// ---- events (legacy drain / claim / ack) -----------------------------------

// AgentEventQuery is the events request: SinceSeq nil means "latest" (no
// anchor filter); Limit is clamped to 1..200 (default 50) by the handler.
type AgentEventQuery struct {
	SinceSeq *int64
	Limit    int
}

// AgentEventBatch is the deliverable batch plus the receipt ingredients:
// AckSeqs/AckMessageIDs are the ids of exactly the returned events (seqs for
// seq-bearing rows, message ids for seq-less rows) — the claim-mode ack
// receipt and the legacy drain's server-side confirmation both cover only
// this returned set, never a cumulative watermark.
type AgentEventBatch struct {
	Events        []presenter.AgentMessageFacts
	HasMore       bool
	AckSeqs       []int64
	AckMessageIDs []string
}

// AgentEventsPort serves the /events family for one authenticated agent.
// DrainEvents is the legacy destructive check (the returned batch is
// acknowledged server-side as part of the request); ClaimEvents returns the
// same selection without acknowledging; AckEvents acknowledges a previously
// claimed batch idempotently — scoped to the authenticated credential's
// agent/workspace, counting only rows actually removed (a replay returns 0,
// foreign or never-claimed ids contribute 0 and are never treated as a
// cumulative cursor).
type AgentEventsPort interface {
	DrainEvents(ctx context.Context, principal agent.CredentialLookup, q AgentEventQuery) (*AgentEventBatch, error)
	ClaimEvents(ctx context.Context, principal agent.CredentialLookup, q AgentEventQuery) (*AgentEventBatch, error)
	AckEvents(ctx context.Context, principal agent.CredentialLookup, seqs []int64, messageIDs []string) (int64, error)
}

// Dependencies carries the M5 port wiring. Every field may be nil: an
// unwired family simply keeps its deferred 501 answer instead of faking
// success. Send requires Targets (a send without target resolution cannot
// serve the CLI contract) and is enforced by NewHandlers.
type Dependencies struct {
	Send    SendAgentPort
	Targets WritableTargetPort
	History AgentHistoryPort
	Events  AgentEventsPort
}
