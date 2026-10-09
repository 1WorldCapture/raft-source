// Package agentdelivery is the M5 delivery application slice owned by the
// integration worker: it binds worker A's durable delivery store to the live
// fact owners — worker C's agent lifecycle service (dispatch facts, the
// controlled machine dispatch entry, persistent start launches) and worker
// B's channel/message reads through the agentconversation service — and
// implements the delivery scheduling and inbox integration seams:
//
//   - the DispatchDeps callbacks A's scheduler runs INSIDE its write
//     transaction (persisted facts only; never the machine hub — the
//     slot -> DB/fence direction exists inside hub.Send, so the reverse
//     edge would be a lock inversion),
//   - the claim/drain/ack inbox exits the Agent API events port consumes.
//
// Receipt adaptation is owned by machinecontrol.DeliveryReceiptAdapter and
// is wired directly at the composition root. State machines stay in delivery,
// identity/lifecycle in agent, and conversation authority in channel/message.
package agentdelivery

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/agentconversation"
	"raft.local/server-go/internal/application/onboarding"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/delivery"
)

// ControlNotice is the private briefing projection the wire encoder turns
// into an agent:deliver body. NoticeID is the logical delivery id, not a
// messages.id. There is no public chat row.
type ControlNotice struct {
	WorkspaceID string
	AgentID     string
	NoticeID    string
	ChannelID   string
	ChannelName string
	Content     string
	CreatedAt   int64
}

// AdmissionDenied is a final Agent/channel/launch refusal made while the
// machine slot is held, before enqueue. Recoverable refusals keep the
// logical intent; permanent ones ask the store to cancel it.
type AdmissionDenied struct {
	Reason      string
	Recoverable bool
}

func (e *AdmissionDenied) Error() string {
	return "agentdelivery: admission denied: " + e.Reason
}

// Transport failures the composition root maps from the machine hub. The
// application package does not import the hub.
var (
	ErrMachineOffline  = errors.New("agentdelivery: machine offline")
	ErrHubClosed       = errors.New("agentdelivery: hub closed")
	ErrSendDeferred    = errors.New("agentdelivery: send queue full")
	ErrDispatchRefused = errors.New("agentdelivery: dispatch refused")
	// ErrProjectionRejected aborts the claim transaction. The caller did not
	// receive a body, and no acknowledgement was committed.
	ErrProjectionRejected = errors.New("agentdelivery: inbox projection rejected")
)

// AdmittedSender is the post-commit machine send. The implementation must
// be SendWithAdmission: the callback runs while the machine slot is held and
// must enqueue only after its own authority check returns.
type AdmittedSender interface {
	SendAdmitted(ctx context.Context, machineID string, payload any, admission func(context.Context, computer.Principal, func() error) error) error
}

// WireEncoder turns application facts into the original agent:deliver
// message JSON. The presenter lives in transport; this package only sees bytes.
type WireEncoder interface {
	EncodeMessage(agentconversation.MessageFacts) (json.RawMessage, error)
	EncodeControl(ControlNotice) (json.RawMessage, error)
}

// Service composes the delivery facts with the live owners. Every dependency
// is frozen at construction; there is no post-construction setter.
type Service struct {
	store         *delivery.Store
	agents        *agent.Service
	directory     *agent.Store
	conversations *agentconversation.Service
	briefings     *onboarding.Service
	logger        *slog.Logger
}

// NewService validates the wiring. Every fact owner is required: production
// has one complete path, and a missing planner, principal source or
// onboarding service is a construction error rather than a silent no-op.
func NewService(store *delivery.Store, agents *agent.Service, directory *agent.Store, conversations *agentconversation.Service, briefings *onboarding.Service, logger *slog.Logger) (*Service, error) {
	if store == nil || agents == nil || directory == nil || conversations == nil || briefings == nil {
		return nil, errors.New("agentdelivery: delivery store, agent service, agent directory, conversation service and onboarding service are required")
	}
	if store.DB() == nil {
		return nil, errors.New("agentdelivery: delivery store owns no database")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		store: store, agents: agents, directory: directory,
		conversations: conversations, briefings: briefings, logger: logger,
	}, nil
}

// Store exposes the durable fact store for composition-time diagnostics
// wiring (the dispatcher and the app use the same instance).
func (s *Service) Store() *delivery.Store { return s.store }

// DispatchDeps builds A's scheduler callbacks. Facts is C's persisted-fact
// reader (machines.last_status projection — NEVER a hub probe, which would
// take the machine slot guard inside the scheduler's write transaction and
// invert the slot -> DB/fence lock order). Authorize revalidates the CURRENT
// conversation read and reply authority of every planned intent on the same
// transaction, so a revoked membership/removed channel cancels the intent
// before any byte is sent; the final admission still happens after commit in
// the hub's current-connection guard.
func (s *Service) DispatchDeps() delivery.DispatchDeps {
	return delivery.DispatchDeps{
		Facts: func(ctx context.Context, ex delivery.Executor, workspaceID, agentID string) (delivery.DispatchFacts, error) {
			facts, err := s.agents.ManagedDispatchFactsTx(ctx, ex, workspaceID, agentID)
			if err != nil {
				return delivery.DispatchFacts{}, err
			}
			return delivery.DispatchFacts{
				SupportsManagedWire: facts.SupportsManagedWire,
				Reachable:           facts.Reachable,
				MachineID:           facts.MachineID,
				LaunchID:            facts.LaunchID,
				SessionID:           facts.SessionID,
				Stopped:             facts.Stopped,
			}, nil
		},
		Authorize: s.authorizeDelivery,
	}
}

// authorizeDelivery revalidates one planned intent's current authorization
// inside the caller's transaction. Reasons are short stable codes recorded on
// the cancelled intent (agent_deleted / conversation_removed /
// agent_not_member); an acknowledged intent is never touched by this path
// (A's own state machine guards that).
func (s *Service) authorizeDelivery(ctx context.Context, ex delivery.Executor, d delivery.Delivery) (bool, string, error) {
	live, err := agentLiveTx(ctx, ex, d.WorkspaceID, d.AgentID)
	if err != nil {
		return false, "", err
	}
	if !live {
		return false, "agent_deleted", nil
	}
	if d.SourceKind == delivery.SourceBriefing {
		if _, err := s.briefings.BriefingTx(ctx, ex, d); err != nil {
			if errors.Is(err, onboarding.ErrBriefingUnavailable) {
				return false, "briefing_unauthorized", nil
			}
			return false, "", err
		}
		return true, "", nil
	}
	if !d.ConversationID.Valid || d.ConversationID.String == "" {
		return false, "conversation_removed", nil
	}
	if _, err := s.conversations.AuthorizeDeliveryTx(ctx, ex, d.WorkspaceID, d.ConversationID.String, d.AgentID); err != nil {
		if de := channel.AsDomainError(err); de != nil {
			switch de.Code {
			case channel.CodeNotFound:
				return false, "conversation_removed", nil
			case channel.CodeForbidden:
				return false, "agent_not_member", nil
			case channel.CodeConflict:
				return false, "channel_archived", nil
			}
		}
		return false, "", err
	}
	return true, "", nil
}

// admit is the final Agent/channel/launch check. The caller holds the machine
// slot and the authority fence for the whole callback, including enqueue.
func (s *Service) admit(ctx context.Context, principal computer.Principal, plan delivery.DispatchPlan) error {
	machineID := ""
	if plan.Attempt.MachineSnapshot.Valid {
		machineID = plan.Attempt.MachineSnapshot.String
	}
	if principal.MachineID == "" || principal.MachineID != machineID || principal.WorkspaceID != plan.Delivery.WorkspaceID {
		return &AdmissionDenied{Reason: "machine_identity_mismatch", Recoverable: true}
	}
	facts, err := s.agents.ManagedDispatchFactsTx(ctx, s.store.DB(), plan.Delivery.WorkspaceID, plan.Delivery.AgentID)
	if err != nil {
		return err
	}
	if facts.Stopped {
		return &AdmissionDenied{Reason: "agent_stopped", Recoverable: true}
	}
	if !plan.Attempt.LaunchSnapshot.Valid || !plan.Attempt.SessionSnapshot.Valid ||
		facts.LaunchID != plan.Attempt.LaunchSnapshot.String ||
		facts.SessionID != plan.Attempt.SessionSnapshot.String ||
		facts.MachineID != machineID {
		return &AdmissionDenied{Reason: "identity_drift", Recoverable: true}
	}
	if plan.Delivery.SourceKind == delivery.SourceBriefing {
		if _, err := s.briefings.BriefingTx(ctx, s.store.DB(), plan.Delivery); err != nil {
			if errors.Is(err, onboarding.ErrBriefingUnavailable) {
				return &AdmissionDenied{Reason: "briefing_unauthorized", Recoverable: false}
			}
			return err
		}
		return nil
	}
	if !plan.Delivery.ConversationID.Valid || plan.Delivery.ConversationID.String == "" {
		return &AdmissionDenied{Reason: "conversation_removed", Recoverable: false}
	}
	if _, err := s.conversations.AuthorizeDeliveryTx(ctx, s.store.DB(), plan.Delivery.WorkspaceID, plan.Delivery.ConversationID.String, plan.Delivery.AgentID); err != nil {
		if de := channel.AsDomainError(err); de != nil {
			switch de.Code {
			case channel.CodeNotFound:
				return &AdmissionDenied{Reason: "conversation_removed", Recoverable: false}
			case channel.CodeForbidden:
				return &AdmissionDenied{Reason: "agent_not_member", Recoverable: false}
			case channel.CodeConflict:
				return &AdmissionDenied{Reason: "channel_archived", Recoverable: false}
			}
		}
		return err
	}
	return nil
}

// agentLiveTx is the narrow liveness fact (agents row not deleted) the
// authorize callback needs for conversation-less intents. Read-only.
func agentLiveTx(ctx context.Context, ex delivery.Executor, workspaceID, agentID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx,
		`SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		agentID, workspaceID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read agent liveness: %w", err)
	}
	return true, nil
}

// PrincipalValidator adapts C's transaction-bound credential revalidation
// onto A's claim/ack validator shape. Claim, drain and ack are read-capability
// surfaces on the original wire, so the enforced capability is "read".
func (s *Service) PrincipalValidator() delivery.AgentPrincipalValidator {
	return func(ctx context.Context, ex delivery.Executor, p delivery.AgentPrincipal) error {
		return s.conversations.ValidatePrincipalTx(ctx, ex, agent.CredentialLookup{
			CredentialID: p.CredentialID,
			AgentID:      p.AgentID,
			WorkspaceID:  p.WorkspaceID,
		}, "read")
	}
}

// agentPrincipalOf adapts the authenticated HTTP lookup onto A's typed
// principal (the slow credential hash already ran at the transport door; the
// validator re-checks the live rows inside the claiming transaction).
func agentPrincipalOf(lookup agent.CredentialLookup) delivery.AgentPrincipal {
	return delivery.AgentPrincipal{
		AgentID:      lookup.AgentID,
		WorkspaceID:  lookup.WorkspaceID,
		CredentialID: lookup.CredentialID,
	}
}

// InboxEvent is one visible inbox row. Exactly one of Message or Notice is
// set. Notice is the private briefing: seq 0, stable delivery id, system
// sender, no public messages row.
type InboxEvent struct {
	Message *agentconversation.MessageFacts
	Notice  *ControlNotice
}

// ClaimedBatch is the projected claim/drain response. AckSeqs carries
// positive message seqs only. AckMessageIDs carries transient notice ids
// (briefing delivery ids), never a public messages.id and never seq 0.
// HasMore is the store's exact page boundary.
type ClaimedBatch struct {
	Events        []InboxEvent
	AckSeqs       []int64
	AckMessageIDs []string
	HasMore       bool
	Reissued      bool
}

// ClaimEvents leases one bounded batch. The principal check, the page, and
// the full projection share one write transaction. Nothing is acknowledged.
// A projection failure rolls the lease back.
func (s *Service) ClaimEvents(ctx context.Context, lookup agent.CredentialLookup, since *int64, limit int) (*ClaimedBatch, error) {
	return s.projectClaim(ctx, lookup, since, limit, false)
}

// DrainEvents is the legacy destructive check. The page is projected on the
// claim executor and only then acknowledged, in that same write transaction.
// A malformed or unreadable projection returns an error and leaves zero
// durable acknowledgement. A committed response that is then lost on the
// wire remains the original protocol's weak window; projection failure is
// not that window.
func (s *Service) DrainEvents(ctx context.Context, lookup agent.CredentialLookup, since *int64, limit int) (*ClaimedBatch, error) {
	return s.projectClaim(ctx, lookup, since, limit, true)
}

func (s *Service) projectClaim(ctx context.Context, lookup agent.CredentialLookup, since *int64, limit int, drain bool) (*ClaimedBatch, error) {
	batch := emptyClaimedBatch()
	projected := false
	project := func(ctx context.Context, ex delivery.Executor, page *delivery.ClaimResult) error {
		if err := s.conversations.ValidatePrincipalTx(ctx, ex, lookup, "read"); err != nil {
			return err
		}
		next, err := s.projectPageTx(ctx, ex, lookup, page)
		if err != nil {
			return err
		}
		batch = next
		projected = true
		return nil
	}
	var err error
	if drain {
		_, _, err = s.store.DrainLegacyEventsQuery(ctx, s.DispatchDeps(), s.PrincipalValidator(), delivery.LegacyDrainQuery{
			Principal: agentPrincipalOf(lookup),
			Limit:     limit,
			SinceSeq:  since,
			Project:   project,
		})
	} else {
		var result *delivery.ClaimResult
		result, err = s.store.ClaimAgentEvents(ctx, s.DispatchDeps(), s.PrincipalValidator(), delivery.ClaimInput{
			Principal: agentPrincipalOf(lookup),
			Limit:     limit,
			SinceSeq:  since,
			Project:   project,
		})
		if err == nil && result != nil && projected {
			batch.Reissued = result.Reissued
		}
	}
	if err != nil {
		return nil, err
	}
	if !projected {
		return emptyClaimedBatch(), nil
	}
	return batch, nil
}

// AckClaim acknowledges a previously claimed batch idempotently. The wire has
// no error branch for an unknown batch (foreign or never-claimed ids count
// 0 and are never a watermark), so A's typed unknown/expired denials map to
// an honest zero, not a failure.
func (s *Service) AckClaim(ctx context.Context, lookup agent.CredentialLookup, seqs []int64, messageIDs []string) (int64, error) {
	result, err := s.store.AckAgentClaim(ctx, s.DispatchDeps(), s.PrincipalValidator(), delivery.ClaimAckInput{
		Principal: agentPrincipalOf(lookup),
		Claim:     delivery.ClaimReceipt{Seqs: seqs, MessageIDs: messageIDs},
	})
	if err != nil {
		switch {
		case errors.Is(err, delivery.ErrClaimUnknown), errors.Is(err, delivery.ErrClaimExpired):
			s.logger.Info("agent claim ack matched no open claim for this principal",
				"agent_id", lookup.AgentID, "workspace_id", lookup.WorkspaceID)
			return 0, nil
		}
		return 0, err
	}
	return result.RemovedCount, nil
}

func emptyClaimedBatch() *ClaimedBatch {
	return &ClaimedBatch{Events: []InboxEvent{}, AckSeqs: []int64{}, AckMessageIDs: []string{}}
}

// projectPageTx renders every visible event on the claim executor. A missing,
// mismatched, or unreadable row rejects the page. Positive-seq messages
// contribute seqs only. Briefings contribute their delivery id and a private
// system notice; they do not insert a messages row or touch read state.
func (s *Service) projectPageTx(ctx context.Context, ex delivery.Executor, lookup agent.CredentialLookup, page *delivery.ClaimResult) (*ClaimedBatch, error) {
	if page == nil {
		return nil, fmt.Errorf("%w: empty claim page", ErrProjectionRejected)
	}
	batch := emptyClaimedBatch()
	batch.HasMore = page.HasMore
	batch.Reissued = page.Reissued
	seqs := make([]int64, 0, len(page.Events))
	ids := make([]string, 0, len(page.Events))
	for _, event := range page.Events {
		switch {
		case event.SourceKind == delivery.SourceBriefing:
			notice, err := s.projectBriefingTx(ctx, ex, event)
			if err != nil {
				return nil, err
			}
			batch.Events = append(batch.Events, InboxEvent{Notice: notice})
			ids = append(ids, notice.NoticeID)
		case event.SourceKind == delivery.SourceMessage && event.MessageID != "" && event.Seq > 0:
			facts, err := s.conversations.MessageFactsTx(ctx, ex, lookup.WorkspaceID, event.ConversationID, event.MessageID, lookup.AgentID)
			if err != nil {
				return nil, err
			}
			if facts.MessageID != event.MessageID || facts.Seq != event.Seq || facts.Seq <= 0 {
				return nil, fmt.Errorf("%w: message %s did not match the claimed row", ErrProjectionRejected, event.MessageID)
			}
			copied := facts
			batch.Events = append(batch.Events, InboxEvent{Message: &copied})
			seqs = append(seqs, event.Seq)
		default:
			return nil, fmt.Errorf("%w: delivery %s is not a readable inbox event", ErrProjectionRejected, event.DeliveryID)
		}
	}
	if !sameInt64s(seqs, page.Claim.Seqs) || !sameStrings(ids, page.Claim.MessageIDs) {
		return nil, fmt.Errorf("%w: rendered receipt does not match the claimed page", ErrProjectionRejected)
	}
	batch.AckSeqs = append([]int64{}, seqs...)
	batch.AckMessageIDs = append([]string{}, ids...)
	return batch, nil
}

func (s *Service) projectBriefingTx(ctx context.Context, ex delivery.Executor, event delivery.ClaimedEvent) (*ControlNotice, error) {
	if event.Seq != 0 || event.MessageID != "" || event.DeliveryID == "" {
		return nil, fmt.Errorf("%w: briefing %s is not a seq-0 notice", ErrProjectionRejected, event.DeliveryID)
	}
	row, err := delivery.DeliveryOnExecutor(ctx, ex, event.DeliveryID)
	if err != nil {
		return nil, err
	}
	briefing, err := s.briefings.BriefingTx(ctx, ex, *row)
	if err != nil {
		return nil, err
	}
	if briefing == nil || briefing.NoticeID != row.ID || briefing.NoticeID == "" || briefing.Content == "" || briefing.ChannelID == "" {
		return nil, fmt.Errorf("%w: briefing %s has no private body", ErrProjectionRejected, event.DeliveryID)
	}
	return &ControlNotice{
		WorkspaceID: briefing.WorkspaceID,
		AgentID:     briefing.AgentID,
		NoticeID:    briefing.NoticeID,
		ChannelID:   briefing.ChannelID,
		ChannelName: briefing.ChannelName,
		Content:     briefing.Content,
		CreatedAt:   briefing.CreatedAt,
	}, nil
}

func sameInt64s(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
