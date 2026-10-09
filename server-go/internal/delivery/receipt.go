package delivery

import (
	"context"
	"database/sql"
	"fmt"
)

// MachinePrincipal is the AUTHENTICATED machine-plane identity handed over by
// machinecontrol after connection admission. It is the authorization source;
// every machine field inside a receipt payload is consistency evidence only.
type MachinePrincipal struct {
	ComputerID  string
	MachineID   string
	WorkspaceID string
}

// MentionSnapshot is the original wire five-tuple identity snapshot carried
// by tracked ACK/transition/terminal_error frames (payload evidence).
type MentionSnapshot struct {
	OccurrenceID string
	MessageID    string
	MachineID    string
	LaunchID     string
	SessionID    string
}

// TransitionInput is one daemon-reported observation (reported receipt, NOT
// model consumption). Duplicate, late or reordered observations are
// idempotent: a timestamp is only ever written NULL -> value.
type TransitionInput struct {
	Principal MachinePrincipal
	AgentID   string
	Stage     string // TransitionReceived | TransitionPending | TransitionDrained
	Snapshot  MentionSnapshot
}

// TransitionResult reports what the observation changed.
type TransitionResult struct {
	Recorded      bool // false when the observation added nothing new
	OccurrenceID  string
	AlreadyClosed bool // the attempt is terminal; nothing could change
}

var transitionColumns = map[string]string{
	TransitionReceived: "received_at",
	TransitionPending:  "pending_at",
	TransitionDrained:  "drained_reported_at",
}

// RecordTransition applies one daemon-reported stage observation.
func (s *Store) RecordTransition(ctx context.Context, input TransitionInput) (TransitionResult, error) {
	column, ok := transitionColumns[input.Stage]
	if !ok {
		return TransitionResult{}, fmt.Errorf("%w: unknown transition stage %q", ErrInvalidInput, input.Stage)
	}
	nowMs := s.nowMs()
	var result TransitionResult
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		attempt, delivery, err := s.locateManagedReceipt(ctx, tx, input.Principal, input.AgentID, input.Snapshot)
		if err != nil {
			return err
		}
		result.OccurrenceID = attempt.OccurrenceID
		// Observations may land on an ACKED attempt (the ACK can legitimately
		// precede the drained report) but never resurrect anything: only the
		// timestamp is supplemented. Non-ACK terminal attempts ignore them.
		if attempt.State == AttemptTerminal {
			if attempt.TerminalCode.Valid && attempt.TerminalCode.String == TerminalAcked {
				result.AlreadyClosed = true
				res, err := tx.ExecContext(ctx,
					`UPDATE agent_delivery_attempts SET `+column+` = ?, updated_at = ?
					WHERE occurrence_id = ? AND `+column+` IS NULL`,
					nowMs, nowMs, attempt.OccurrenceID)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n == 1 {
					result.Recorded = true
				}
				return nil
			}
			result.AlreadyClosed = true
			return nil
		}
		res, err := tx.ExecContext(ctx,
			`UPDATE agent_delivery_attempts SET `+column+` = ?, revision = revision + 1, updated_at = ?
			WHERE occurrence_id = ? AND `+column+` IS NULL AND state = 'in_flight'`,
			nowMs, nowMs, attempt.OccurrenceID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			result.Recorded = true
		}
		_ = delivery // delivery state never changes on a mere observation
		return nil
	})
	if err != nil {
		return TransitionResult{}, err
	}
	return result, nil
}

// AckInput is one agent:deliver:ack. Snapshot == nil means a LEGACY ack
// without deliveryId/mentionDelivery: every attempt this store manages is a
// tracked occurrence, so a legacy ack is rejected — never guessed by max(seq).
type AckInput struct {
	Principal MachinePrincipal
	AgentID   string
	Seq       int64 // the wire seq: must equal messages.seq of the message
	Snapshot  *MentionSnapshot
}

// AckResult reports the idempotent outcome.
type AckResult struct {
	DeliveryID          string
	OccurrenceID        string
	AlreadyAcknowledged bool
}

// AcknowledgeManaged applies the receipt admission order in one short
// transaction: authenticated principal -> locate the attempt owned by that
// subject -> full five-tuple identity closure -> idempotent CAS. Any denial
// leaves zero state change. Tracked acks require a positive message seq;
// seq 0 is not a watermark and cannot confirm a briefing attempt.
func (s *Store) AcknowledgeManaged(ctx context.Context, input AckInput) (AckResult, error) {
	if input.Snapshot == nil {
		return AckResult{}, ErrLegacyAckAmbiguous
	}
	if input.Seq <= 0 {
		return AckResult{}, fmt.Errorf("%w: tracked ack requires a positive message seq", ErrIdentityMismatch)
	}
	nowMs := s.nowMs()
	var result AckResult
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		attempt, delivery, err := s.locateManagedReceipt(ctx, tx, input.Principal, input.AgentID, *input.Snapshot)
		if err != nil {
			return err
		}
		// Null-message briefing attempts are confirmed only by
		// AcknowledgeControl. A crafted five-tuple must not cross over.
		if delivery.SourceKind != SourceMessage || !delivery.MessageID.Valid || !attempt.MessageID.Valid {
			return ErrControlPathMismatch
		}
		result.DeliveryID = attempt.DeliveryID
		result.OccurrenceID = attempt.OccurrenceID

		// wire seq must repeat the message's committed seq exactly.
		seq, found, err := messageSeqTx(ctx, tx, attempt.WorkspaceID, attempt.MessageID.String)
		if err != nil {
			return err
		}
		if !found || seq != input.Seq {
			return ErrIdentityMismatch
		}

		if attempt.State == AttemptTerminal {
			if attempt.AckedAt.Valid {
				result.AlreadyAcknowledged = true
				return nil
			}
			// A late ack on a TERMINAL attempt (superseded, drift-closed or
			// cancelled) is an audit fact about that OLD occurrence only: the
			// receipt is recorded, but it can never confirm a newer attempt
			// nor resurrect a cancelled intent.
			if _, err := tx.ExecContext(ctx,
				`UPDATE agent_delivery_attempts SET acked_at = ?, updated_at = ?
				WHERE occurrence_id = ? AND acked_at IS NULL`,
				nowMs, nowMs, attempt.OccurrenceID); err != nil {
				return err
			}
			return nil
		}

		// Close the attempt with the ACK verdict (CAS on revision). The
		// schema CHECK (terminal_code='ACKED' requires acked_at) forces both
		// columns into the SAME statement — there is no intermediate row
		// where the verdict exists without its receipt timestamp.
		res, err := tx.ExecContext(ctx, `UPDATE agent_delivery_attempts
			SET state = 'terminal', terminal_code = 'ACKED', acked_at = ?,
			    revision = revision + 1, updated_at = ?
			WHERE occurrence_id = ? AND state = 'in_flight' AND revision = ?`,
			nowMs, nowMs, attempt.OccurrenceID, attempt.Revision)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return ErrConcurrentModification
		}
		// The logical intent is acknowledged only when THIS attempt is its
		// open occurrence. A cancelled intent keeps its verdict (no
		// resurrection); an already-acknowledged intent stays at its first
		// confirmation time (no refresh).
		if delivery.SchedulingState == StateLeased || delivery.SchedulingState == StatePending ||
			delivery.SchedulingState == StateWaitingMachine || delivery.SchedulingState == StateWaitingIdentity ||
			delivery.SchedulingState == StateBlocked {
			if err := transitionDeliveryTx(ctx, tx, delivery, DeliveryTransition{
				State:          StateAcknowledged,
				ErrorCode:      sql.NullString{},
				LeaseExpiresAt: sql.NullInt64{},
			}, nowMs); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE agent_deliveries SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`,
				nowMs, delivery.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return AckResult{}, err
	}
	return result, nil
}

// ControlAckInput is one seq-0 control notice ack (onboarding briefing).
// LaunchID and SessionID are the agent's CURRENT persisted launch and
// session, supplied by the caller from agent facts — the wire frame has
// neither. The authenticated principal is the current connection's machine
// identity (machinews admission); payload fields are not an identity source
// because this frame carries none.
type ControlAckInput struct {
	Principal    MachinePrincipal
	AgentID      string
	OccurrenceID string
	LaunchID     string
	SessionID    string
}

// AcknowledgeControl confirms one SourceBriefing null-message attempt inside
// one write transaction. The occurrence, authenticated machine/workspace/agent
// and the current launch/session must all match the attempt snapshot. A
// duplicate of that same current identity is idempotent and does not refresh
// the first confirmation time. Foreign principals, old launches/sessions,
// tracked message attempts and already-closed occurrences leave zero writes.
// seq 0 names this occurrence only; it does not clear any other intent.
// The resulting acknowledged row is a reported receipt, not model consumption:
// received/pending/drained timestamps are not invented.
func (s *Store) AcknowledgeControl(ctx context.Context, input ControlAckInput) (AckResult, error) {
	if input.Principal.MachineID == "" || input.Principal.WorkspaceID == "" ||
		input.AgentID == "" || input.OccurrenceID == "" ||
		input.LaunchID == "" || input.SessionID == "" {
		return AckResult{}, fmt.Errorf("%w: principal, agent, occurrence and current launch/session are required", ErrInvalidInput)
	}
	nowMs := s.nowMs()
	var result AckResult
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		attempt, err := attemptByOccurrenceTx(ctx, tx, input.OccurrenceID)
		if err != nil {
			return err
		}
		if attempt == nil {
			return ErrOccurrenceUnknown
		}
		delivery, err := deliveryByIDTx(ctx, tx, attempt.DeliveryID)
		if err != nil || delivery == nil {
			return fmt.Errorf("reload delivery: %w", err)
		}
		if delivery.SourceKind != SourceBriefing || delivery.MessageID.Valid || attempt.MessageID.Valid {
			return ErrControlPathMismatch
		}
		if attempt.TransportKind != TransportManagedWire {
			return ErrIdentityMismatch
		}
		if attempt.WorkspaceID != input.Principal.WorkspaceID || attempt.AgentID != input.AgentID ||
			delivery.WorkspaceID != input.Principal.WorkspaceID || delivery.AgentID != input.AgentID {
			return ErrIdentityMismatch
		}
		if !attempt.MachineSnapshot.Valid || attempt.MachineSnapshot.String != input.Principal.MachineID {
			return ErrIdentityMismatch
		}
		if !attempt.LaunchSnapshot.Valid || attempt.LaunchSnapshot.String != input.LaunchID ||
			!attempt.SessionSnapshot.Valid || attempt.SessionSnapshot.String != input.SessionID {
			return ErrIdentityMismatch
		}
		result.DeliveryID = attempt.DeliveryID
		result.OccurrenceID = attempt.OccurrenceID
		if delivery.SchedulingState == StateCancelled {
			return ErrAttemptTerminal
		}
		if attempt.State == AttemptTerminal {
			if attempt.AckedAt.Valid && attempt.TerminalCode.Valid && attempt.TerminalCode.String == TerminalAcked {
				result.AlreadyAcknowledged = true
				return nil
			}
			// Superseded, drifted or otherwise closed: an old control receipt
			// does not audit-mutate the row and cannot confirm a newer attempt.
			return ErrAttemptTerminal
		}
		res, err := tx.ExecContext(ctx, `UPDATE agent_delivery_attempts
			SET state = 'terminal', terminal_code = 'ACKED', acked_at = ?,
			    revision = revision + 1, updated_at = ?
			WHERE occurrence_id = ? AND state = 'in_flight' AND revision = ?`,
			nowMs, nowMs, attempt.OccurrenceID, attempt.Revision)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return ErrConcurrentModification
		}
		if delivery.SchedulingState == StateLeased || delivery.SchedulingState == StatePending ||
			delivery.SchedulingState == StateWaitingMachine || delivery.SchedulingState == StateWaitingIdentity ||
			delivery.SchedulingState == StateBlocked {
			if err := transitionDeliveryTx(ctx, tx, delivery, DeliveryTransition{
				State:          StateAcknowledged,
				ErrorCode:      sql.NullString{},
				LeaseExpiresAt: sql.NullInt64{},
			}, nowMs); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx,
				`UPDATE agent_deliveries SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`,
				nowMs, delivery.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return AckResult{}, err
	}
	return result, nil
}

// TerminalErrorInput is one agent:delivery:terminal_error frame. The six
// codes are the original closed wire set.
type TerminalErrorInput struct {
	Principal MachinePrincipal
	AgentID   string
	Code      string
	Snapshot  MentionSnapshot
}

// TerminalErrorResult summarizes the applied category.
type TerminalErrorResult struct {
	OccurrenceID  string
	DeliveryState string
}

var terminalErrorCodes = map[string]bool{
	TerminalIdentityUnknown: true, TerminalIdentityDrift: true,
	TerminalQuotaLimited: true, TerminalDeliveryRejected: true,
	TerminalUnsupportedPath: true, TerminalInstrumentFailed: true,
}

// RecordTerminalError applies the per-category handling with generation
// matching: the error only acts on the attempt whose machine/launch/session
// snapshot it repeats. An old generation's error never cancels a delivery a
// new generation has taken over.
func (s *Store) RecordTerminalError(ctx context.Context, input TerminalErrorInput) (TerminalErrorResult, error) {
	if !terminalErrorCodes[input.Code] {
		return TerminalErrorResult{}, fmt.Errorf("%w: unknown terminal error code %q", ErrInvalidInput, input.Code)
	}
	nowMs := s.nowMs()
	var result TerminalErrorResult
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		attempt, delivery, err := s.locateManagedReceipt(ctx, tx, input.Principal, input.AgentID, input.Snapshot)
		if err != nil {
			return err
		}
		result.OccurrenceID = attempt.OccurrenceID
		if attempt.State == AttemptTerminal {
			result.DeliveryState = delivery.SchedulingState
			return nil // generation already closed; zero state change
		}
		ok, err := terminateAttemptTx(ctx, tx, attempt.OccurrenceID, input.Code, attempt.Revision, nowMs)
		if err != nil {
			return err
		}
		if !ok {
			return ErrConcurrentModification
		}
		switch input.Code {
		case TerminalIdentityUnknown, TerminalIdentityDrift, TerminalInstrumentFailed:
			// Recoverable attempt failure: the logical intent stays alive
			// with persistent backoff; it is never permanently killed by an
			// identity report. Budget already consumed by the send itself.
			next := nowMs + jitteredBackoff(delivery.ID, delivery.RetryCount).Milliseconds()
			if BudgetExhausted(delivery.RetryCount) {
				result.DeliveryState = StateBlocked
				return blockDeliveryTx(ctx, tx, delivery, TerminalRetryExhausted, nowMs)
			}
			result.DeliveryState = StatePending
			return transitionDeliveryTx(ctx, tx, delivery, DeliveryTransition{
				State:          StatePending,
				NextAttemptAt:  next,
				HasNextAttempt: true,
				ErrorCode:      nullableString(input.Code),
			}, nowMs)
		case TerminalQuotaLimited, TerminalUnsupportedPath:
			result.DeliveryState = StateBlocked
			return blockDeliveryTx(ctx, tx, delivery, input.Code, nowMs)
		case TerminalDeliveryRejected:
			result.DeliveryState = StateCancelled
			return transitionDeliveryTx(ctx, tx, delivery, DeliveryTransition{
				State:     StateCancelled,
				ErrorCode: nullableString(input.Code),
			}, nowMs)
		}
		return nil
	})
	if err != nil {
		return TerminalErrorResult{}, err
	}
	return result, nil
}

// locateManagedReceipt performs the receipt admission checks shared by every
// machine-plane receipt: the attempt must exist, belong to the authenticated
// principal's workspace and agent, and its immutable identity snapshot must
// close exactly with the payload five-tuple (payload machine id is only
// consistency evidence — the AUTHENTICATED principal machine must equal it).
func (s *Store) locateManagedReceipt(ctx context.Context, ex Executor, principal MachinePrincipal, agentID string, snapshot MentionSnapshot) (*Attempt, *Delivery, error) {
	if principal.MachineID == "" || principal.WorkspaceID == "" || agentID == "" || snapshot.OccurrenceID == "" {
		return nil, nil, fmt.Errorf("%w: principal, agent and snapshot occurrence are required", ErrInvalidInput)
	}
	attempt, err := attemptByOccurrenceTx(ctx, ex, snapshot.OccurrenceID)
	if err != nil {
		return nil, nil, err
	}
	if attempt == nil {
		return nil, nil, ErrOccurrenceUnknown
	}
	if attempt.TransportKind != TransportManagedWire {
		return nil, nil, ErrIdentityMismatch
	}
	// Subject ownership: the attempt must belong to the authenticated
	// workspace + agent. Another agent's occurrence is invisible.
	if attempt.WorkspaceID != principal.WorkspaceID || attempt.AgentID != agentID {
		return nil, nil, ErrIdentityMismatch
	}
	// Authentication source vs payload evidence vs stored snapshot: all
	// three must agree on the machine.
	if !attempt.MachineSnapshot.Valid || attempt.MachineSnapshot.String != principal.MachineID {
		return nil, nil, ErrIdentityMismatch
	}
	if snapshot.MachineID != principal.MachineID {
		return nil, nil, ErrIdentityMismatch
	}
	if !attempt.LaunchSnapshot.Valid || attempt.LaunchSnapshot.String != snapshot.LaunchID {
		return nil, nil, ErrIdentityMismatch
	}
	if !attempt.SessionSnapshot.Valid || attempt.SessionSnapshot.String != snapshot.SessionID {
		return nil, nil, ErrIdentityMismatch
	}
	if attempt.MessageID.Valid && attempt.MessageID.String != snapshot.MessageID {
		return nil, nil, ErrIdentityMismatch
	}
	delivery, err := deliveryByIDTx(ctx, ex, attempt.DeliveryID)
	if err != nil || delivery == nil {
		return nil, nil, fmt.Errorf("reload delivery: %w", err)
	}
	if delivery.WorkspaceID != principal.WorkspaceID || delivery.AgentID != agentID {
		return nil, nil, ErrIdentityMismatch
	}
	return attempt, delivery, nil
}
