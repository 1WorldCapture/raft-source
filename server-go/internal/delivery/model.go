package delivery

import (
	"database/sql"
)

// Scheduling states of a logical delivery intent. The scheduling axis answers
// "what should the dispatcher do next"; receipt evidence lives on attempts.
const (
	StatePending         = "pending"
	StateWaitingMachine  = "waiting_machine"
	StateWaitingIdentity = "waiting_identity"
	StateLeased          = "leased"
	StateAcknowledged    = "acknowledged"
	StateBlocked         = "blocked"
	StateCancelled       = "cancelled"
)

// Source kinds. Every kind must have a real product use case; this is not a
// generic JSON job platform.
const (
	SourceMessage  = "message"
	SourceBriefing = "briefing"
)

// Transport kinds of an attempt. managed_wire requires the full
// machine/launch/session identity snapshot; external_claim binds the claim
// lease instead and never fabricates machine identity.
const (
	TransportManagedWire   = "managed_wire"
	TransportExternalClaim = "external_claim"
)

// Attempt lifecycle states.
const (
	AttemptInFlight = "in_flight"
	AttemptTerminal = "terminal"
)

// The six original wire terminal-error codes.
const (
	TerminalIdentityUnknown  = "IDENTITY_UNKNOWN"
	TerminalIdentityDrift    = "IDENTITY_DRIFT"
	TerminalQuotaLimited     = "QUOTA_LIMITED"
	TerminalDeliveryRejected = "DELIVERY_REJECTED"
	TerminalUnsupportedPath  = "UNSUPPORTED_DELIVERY_PATH"
	TerminalInstrumentFailed = "INSTRUMENT_FAILED"
)

// Server-side terminal codes (verdicts this module records itself; they are
// never daemon reports).
const (
	TerminalAcked          = "ACKED"
	TerminalRetryExhausted = "RETRY_EXHAUSTED"
	TerminalSuperseded     = "SUPERSEDED"
	TerminalCancelled      = "CANCELLED"
	TerminalSendFailed     = "SEND_FAILED"
	TerminalLeaseExpired   = "LEASE_EXPIRED"
)

// Daemon-reported transition stages (reported observations only).
const (
	TransitionReceived = "daemon_received"
	TransitionPending  = "daemon_pending"
	TransitionDrained  = "daemon_drained"
)

// deliveryColumns is the read column list for every agent_deliveries query.
const deliveryColumns = `id, delivery_order, workspace_id, agent_id, source_kind, source_id,
	message_id, conversation_id, scheduling_state, retry_count, next_attempt_at,
	lease_expires_at, last_error_code, acknowledged_at, revision, created_at, updated_at`

// Delivery is one committed agent_deliveries row.
type Delivery struct {
	ID              string
	DeliveryOrder   int64
	WorkspaceID     string
	AgentID         string
	SourceKind      string
	SourceID        string
	MessageID       sql.NullString
	ConversationID  sql.NullString
	SchedulingState string
	RetryCount      int64
	NextAttemptAt   int64
	LeaseExpiresAt  sql.NullInt64
	LastErrorCode   sql.NullString
	AcknowledgedAt  sql.NullInt64
	Revision        int64
	CreatedAt       int64
	UpdatedAt       int64
}

func scanDelivery(scanner interface{ Scan(dest ...any) error }) (*Delivery, error) {
	var d Delivery
	if err := scanner.Scan(&d.ID, &d.DeliveryOrder, &d.WorkspaceID, &d.AgentID,
		&d.SourceKind, &d.SourceID, &d.MessageID, &d.ConversationID,
		&d.SchedulingState, &d.RetryCount, &d.NextAttemptAt, &d.LeaseExpiresAt,
		&d.LastErrorCode, &d.AcknowledgedAt, &d.Revision, &d.CreatedAt, &d.UpdatedAt); err != nil {
		return nil, err
	}
	return &d, nil
}

// attemptColumns is the read column list for every attempt query. The
// identity snapshot columns are immutable after insert.
const attemptColumns = `occurrence_id, delivery_id, attempt_number, workspace_id, agent_id,
	message_id, machine_id_snapshot, launch_id_snapshot, session_id_snapshot,
	transport_kind, claim_id, lease_expires_at, retry_count, dispatched_at,
	received_at, pending_at, drained_reported_at, acked_at, state, terminal_code,
	revision, created_at, updated_at`

// Attempt is one committed agent_delivery_attempts row: one protocol
// occurrence bound to one identity snapshot. Retries with the same identity
// reuse the occurrence; identity drift terminal-closes the old attempt and a
// new occurrence is minted.
type Attempt struct {
	OccurrenceID      string
	DeliveryID        string
	AttemptNumber     int64
	WorkspaceID       string
	AgentID           string
	MessageID         sql.NullString
	MachineSnapshot   sql.NullString
	LaunchSnapshot    sql.NullString
	SessionSnapshot   sql.NullString
	TransportKind     string
	ClaimID           sql.NullString
	LeaseExpiresAt    sql.NullInt64
	RetryCount        int64
	DispatchedAt      sql.NullInt64
	ReceivedAt        sql.NullInt64
	PendingAt         sql.NullInt64
	DrainedReportedAt sql.NullInt64
	AckedAt           sql.NullInt64
	State             string
	TerminalCode      sql.NullString
	Revision          int64
	CreatedAt         int64
	UpdatedAt         int64
}

func scanAttempt(scanner interface{ Scan(dest ...any) error }) (*Attempt, error) {
	var a Attempt
	if err := scanner.Scan(&a.OccurrenceID, &a.DeliveryID, &a.AttemptNumber,
		&a.WorkspaceID, &a.AgentID, &a.MessageID, &a.MachineSnapshot,
		&a.LaunchSnapshot, &a.SessionSnapshot, &a.TransportKind, &a.ClaimID,
		&a.LeaseExpiresAt, &a.RetryCount, &a.DispatchedAt, &a.ReceivedAt,
		&a.PendingAt, &a.DrainedReportedAt, &a.AckedAt, &a.State,
		&a.TerminalCode, &a.Revision, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	return &a, nil
}
