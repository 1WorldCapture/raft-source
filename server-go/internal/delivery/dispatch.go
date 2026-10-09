package delivery

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// DispatchFacts are the live per-agent managed-wire facts resolved INSIDE the
// dispatching transaction by an injected agent-module callback. They are the
// authorization-adjacent live facts this package refuses to read itself.
type DispatchFacts struct {
	// SupportsManagedWire is false for agents whose runtime can never receive
	// agent:deliver (external runner agents): their intents are claim-only.
	SupportsManagedWire bool
	// Reachable reports a currently admitted machine connection.
	Reachable bool
	// MachineID is the agent's current machine binding (live fact).
	MachineID string
	// LaunchID is the current persistent launch id ("" = not formed yet).
	LaunchID string
	// SessionID is the current runtime session id ("" = not formed yet).
	SessionID string
	// Stopped means the user explicitly stopped the agent: a waiting fact
	// that never burns budget and never force-wakes.
	Stopped bool
}

// AgentFactsFn resolves DispatchFacts inside the caller's transaction. It may
// run short SQL only — never network I/O.
type AgentFactsFn func(ctx context.Context, ex Executor, workspaceID, agentID string) (DispatchFacts, error)

// DeliveryAuthorizationFn revalidates the CURRENT authorization of one
// planned intent (agent alive, membership still grants this delivery).
// authorized=false with a short stable reason code cancels the intent.
type DeliveryAuthorizationFn func(ctx context.Context, ex Executor, d Delivery) (authorized bool, reason string, err error)

// DispatchDeps bundles the injected cross-module fact callbacks. Both fields
// are required by every dispatching entry point.
type DispatchDeps struct {
	Facts     AgentFactsFn
	Authorize DeliveryAuthorizationFn
}

func (d DispatchDeps) validate() error {
	if d.Facts == nil {
		return fmt.Errorf("%w: Facts callback is required", ErrInvalidInput)
	}
	if d.Authorize == nil {
		return fmt.Errorf("%w: Authorize callback is required", ErrInvalidInput)
	}
	return nil
}

// PrepareInput bounds one managed dispatch scan round.
type PrepareInput struct {
	Now         time.Time // zero means the store clock
	MaxPerAgent int       // <=0 defaults to 1 (single outstanding managed attempt per agent)
	MaxTotal    int       // <=0 defaults to 64, hard cap 512
}

// DispatchPlan is one leased occurrence ready for the wire. MessageSeq is
// messages.seq — the ORIGINAL wire seq; delivery_order is internal ordering
// only and must never be sent in the seq field.
type DispatchPlan struct {
	Delivery   Delivery
	Attempt    Attempt
	MessageSeq int64
}

// PrepareManagedDispatches scans due logical intents in one write transaction
// and returns leased dispatch plans. It performs NO network I/O: the wire
// send happens after commit through the machine connection admission path.
//
// The single-outstanding rule (one in-flight managed attempt per agent), the
// identity-stable occurrence reuse, the no-budget waiting states and the
// authorization re-check all run here, under one fence.
func (s *Store) PrepareManagedDispatches(ctx context.Context, deps DispatchDeps, input PrepareInput) ([]DispatchPlan, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	now := input.Now
	if now.IsZero() {
		now = s.now()
	}
	nowMs := now.UnixMilli()
	maxPerAgent := input.MaxPerAgent
	if maxPerAgent <= 0 {
		maxPerAgent = scanDefaultPerAgent
	}
	maxTotal := input.MaxTotal
	if maxTotal <= 0 {
		maxTotal = scanDefaultTotal
	}
	if maxTotal > scanMaxTotal {
		maxTotal = scanMaxTotal
	}

	s.managedScanMu.Lock()
	defer s.managedScanMu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var plans []DispatchPlan
	nextScanAfter := s.managedScanAfter
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		// Expired leases become re-preparable first (restart/slow-scan
		// normalization); no budget is consumed by the recovery itself.
		if _, err := recoverExpiredLeasesTx(ctx, tx, nowMs); err != nil {
			return err
		}
		const scanLimit = scanMaxTotal * 4
		due, err := loadDueDeliveriesAfterTx(ctx, tx, nowMs, nextScanAfter, scanLimit)
		if err != nil {
			return err
		}
		// Wrap when the cursor reaches the end. No delivery state or retry
		// timestamp is changed merely to get an external row out of the way.
		if len(due) == 0 && nextScanAfter != 0 {
			nextScanAfter = 0
			due, err = loadDueDeliveriesAfterTx(ctx, tx, nowMs, 0, scanLimit)
			if err != nil {
				return err
			}
		}
		exhaustedPage := true
		preparedPerAgent := map[string]int{}
		inFlight := map[string]bool{}
		for i := range due {
			if len(plans) >= maxTotal {
				exhaustedPage = false
				break
			}
			d := due[i]
			nextScanAfter = d.DeliveryOrder
			authorized, reason, err := deps.Authorize(ctx, tx, d)
			if err != nil {
				return err
			}
			if !authorized {
				// Same transaction as the cancel. An occurrence left in_flight
				// would keep this agent's slot, and a later receipt could
				// rewrite that cancelled attempt to ACKED. CANCELLED keeps
				// any recorded observations and is not itself a receipt.
				if d.SchedulingState != StateAcknowledged && d.SchedulingState != StateCancelled {
					if err := terminalCloseOpenAttemptTx(ctx, tx, d.ID, TerminalCancelled, nowMs); err != nil {
						return err
					}
				}
				if err := cancelDeliveryTx(ctx, tx, &d, reason, nowMs); err != nil {
					return err
				}
				continue
			}
			facts, err := deps.Facts(ctx, tx, d.WorkspaceID, d.AgentID)
			if err != nil {
				return err
			}
			if !facts.SupportsManagedWire {
				// The independent scan cursor provides fairness past a large
				// external backlog. Its pull eligibility, revision and retry
				// budget must remain completely unchanged by a managed scan.
				continue
			}
			if facts.Stopped || !facts.Reachable {
				code := "machine_offline"
				if facts.Stopped {
					code = "agent_stopped"
				}
				if err := markWaitingTx(ctx, tx, &d, StateWaitingMachine, code, nowMs); err != nil {
					return err
				}
				continue
			}
			if facts.MachineID == "" || facts.LaunchID == "" || facts.SessionID == "" {
				if err := markWaitingTx(ctx, tx, &d, StateWaitingIdentity, "identity_incomplete", nowMs); err != nil {
					return err
				}
				continue
			}
			// Fairness: at most MaxPerAgent leases per agent per round, and
			// at most ONE outstanding managed attempt per agent overall.
			// Cancelled and blocked intents do not count as outstanding.
			if inFlight[d.AgentID] || preparedPerAgent[d.AgentID] >= maxPerAgent {
				continue
			}
			other, err := agentHasOtherInFlightTx(ctx, tx, d.WorkspaceID, d.AgentID, d.ID)
			if err != nil {
				return err
			}
			if other {
				continue
			}
			plan, err := s.leaseManagedAttemptTx(ctx, tx, &d, facts, nowMs)
			if err != nil {
				return err
			}
			if plan != nil {
				plans = append(plans, *plan)
				preparedPerAgent[d.AgentID]++
				inFlight[d.AgentID] = true
			}
		}
		if exhaustedPage && len(due) < scanLimit {
			nextScanAfter = 0
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Publish the hint only after a successful commit, never on rollback.
	s.managedScanAfter = nextScanAfter
	return plans, nil
}

// leaseManagedAttemptTx applies the budget, then either reuses the open
// occurrence (same identity) or terminal-closes it as SUPERSEDED and mints a
// new one (identity drift). Returns nil when the budget was exhausted (the
// delivery is blocked instead of leased).
func (s *Store) leaseManagedAttemptTx(ctx context.Context, ex Executor, d *Delivery, facts DispatchFacts, nowMs int64) (*DispatchPlan, error) {
	if BudgetExhausted(d.RetryCount) {
		if err := blockDeliveryTx(ctx, ex, d, TerminalRetryExhausted, nowMs); err != nil {
			return nil, err
		}
		open, err := openAttemptForDeliveryTx(ctx, ex, d.ID)
		if err != nil {
			return nil, err
		}
		if open != nil {
			ok, err := terminateAttemptTx(ctx, ex, open.OccurrenceID, TerminalRetryExhausted, open.Revision, nowMs)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, ErrConcurrentModification
			}
		}
		return nil, nil
	}

	newRetry := d.RetryCount + 1
	leaseMs := nowMs + LeaseTTLFor(newRetry).Milliseconds()
	attempt, err := openAttemptForDeliveryTx(ctx, ex, d.ID)
	if err != nil {
		return nil, err
	}
	if attempt != nil {
		sameIdentity := attempt.TransportKind == TransportManagedWire &&
			attempt.MachineSnapshot.Valid && attempt.MachineSnapshot.String == facts.MachineID &&
			attempt.LaunchSnapshot.Valid && attempt.LaunchSnapshot.String == facts.LaunchID &&
			attempt.SessionSnapshot.Valid && attempt.SessionSnapshot.String == facts.SessionID
		if !sameIdentity {
			// Drift with a daemon-REPORTED observation (received/pending/
			// drained) is an UNCERTAIN outcome: whether the runtime consumed
			// the input is unknowable. Block for explicit diagnosis. Do not
			// mint a replacement occurrence and do not invent an ACK.
			//
			// The attempt stays in_flight so a genuine five-tuple ACK of
			// THIS occurrence can still acknowledge the blocked intent
			// (AcknowledgeManaged only does that while the attempt is
			// in_flight). It does not occupy the single-agent slot:
			// agentHasOtherInFlightTx ignores blocked and cancelled parents.
			// RequeueBlocked is what terminal-closes it, so the next prepare
			// can mint a new occurrence instead of blocking again.
			if attempt.ReceivedAt.Valid || attempt.PendingAt.Valid || attempt.DrainedReportedAt.Valid {
				if err := blockDeliveryTx(ctx, ex, d, "uncertain_delivery", nowMs); err != nil {
					return nil, err
				}
				return nil, nil
			}
			// Identity drift without receipt evidence: never rewrite the old
			// snapshot in place. The old occurrence is terminal-closed; its
			// late receipts can at most record audit facts and can never
			// confirm the new attempt.
			ok, err := terminateAttemptTx(ctx, ex, attempt.OccurrenceID, TerminalSuperseded, attempt.Revision, nowMs)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, ErrConcurrentModification
			}
			attempt = nil
		}
	}
	if attempt == nil {
		occurrence, err := newTokenID()
		if err != nil {
			return nil, fmt.Errorf("mint occurrence: %w", err)
		}
		var nextNumber int64 = 1
		if err := ex.QueryRowContext(ctx,
			`SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM agent_delivery_attempts WHERE delivery_id = ?`,
			d.ID).Scan(&nextNumber); err != nil {
			return nil, err
		}
		res, err := ex.ExecContext(ctx, `INSERT INTO agent_delivery_attempts
			(occurrence_id, delivery_id, attempt_number, workspace_id, agent_id, message_id,
			 machine_id_snapshot, launch_id_snapshot, session_id_snapshot, transport_kind,
			 claim_id, lease_expires_at, retry_count, dispatched_at, received_at, pending_at,
			 drained_reported_at, acked_at, state, terminal_code, revision, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,0,NULL,NULL,NULL,NULL,NULL,'in_flight',NULL,1,?,?)`,
			occurrence, d.ID, nextNumber, d.WorkspaceID, d.AgentID, d.MessageID,
			nullableString(facts.MachineID), nullableString(facts.LaunchID), nullableString(facts.SessionID),
			TransportManagedWire, leaseMs, nowMs, nowMs)
		if err != nil {
			return nil, fmt.Errorf("insert attempt: %w", err)
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, fmt.Errorf("insert attempt: no row written")
		}
		attempt, err = attemptByOccurrenceTx(ctx, ex, occurrence)
		if err != nil || attempt == nil {
			return nil, fmt.Errorf("reload attempt: %w", err)
		}
	} else {
		// Same identity: network-level retry REUSES the occurrence so the
		// daemon can dedup; only lease/retry bookkeeping advances.
		res, err := ex.ExecContext(ctx, `UPDATE agent_delivery_attempts
			SET retry_count = retry_count + 1, lease_expires_at = ?, revision = revision + 1, updated_at = ?
			WHERE occurrence_id = ? AND state = 'in_flight' AND revision = ?`,
			leaseMs, nowMs, attempt.OccurrenceID, attempt.Revision)
		if err != nil {
			return nil, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return nil, ErrConcurrentModification
		}
		attempt.RetryCount++
		attempt.LeaseExpiresAt = sql.NullInt64{Int64: leaseMs, Valid: true}
		attempt.Revision++
	}
	if err := transitionDeliveryTx(ctx, ex, d, DeliveryTransition{
		State:          StateLeased,
		RetryCount:     &newRetry,
		LeaseExpiresAt: sql.NullInt64{Int64: leaseMs, Valid: true},
		ErrorCode:      sql.NullString{},
	}, nowMs); err != nil {
		return nil, err
	}
	seq := int64(0)
	if d.MessageID.Valid {
		var found bool
		seq, found, err = messageSeqTx(ctx, ex, d.WorkspaceID, d.MessageID.String)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, fmt.Errorf("delivery %s references a missing message %s", d.ID, d.MessageID.String)
		}
	}
	return &DispatchPlan{Delivery: *d, Attempt: *attempt, MessageSeq: seq}, nil
}

// SendOutcome reports the wire result of one prepared plan AFTER the sending
// transaction committed. The store only supplements observations: an ACK that
// raced ahead of the Send return is never overwritten back to pending.
type SendOutcome struct {
	OccurrenceID string
	Accepted     bool
	ErrorCode    string // required when !Accepted (short stable code)
	Recoverable  bool
}

// RecordManagedSendResult records the post-commit send observation.
func (s *Store) RecordManagedSendResult(ctx context.Context, outcome SendOutcome) error {
	if outcome.OccurrenceID == "" {
		return fmt.Errorf("%w: occurrence is required", ErrInvalidInput)
	}
	nowMs := s.nowMs()
	return s.withWriteTx(ctx, func(tx *sql.Tx) error {
		attempt, err := attemptByOccurrenceTx(ctx, tx, outcome.OccurrenceID)
		if err != nil {
			return err
		}
		if attempt == nil {
			return ErrOccurrenceUnknown
		}
		if attempt.State == AttemptTerminal {
			if attempt.TerminalCode.Valid && attempt.TerminalCode.String == TerminalAcked {
				return nil // ACK already raced ahead: keep the stronger fact.
			}
			return nil // closed by another verdict; the observation is moot.
		}
		if outcome.Accepted {
			// dispatched_at is an observation supplement: never overwrite an
			// existing receipt and never touch the state.
			_, err := tx.ExecContext(ctx,
				`UPDATE agent_delivery_attempts SET dispatched_at = ?, updated_at = ?
				WHERE occurrence_id = ? AND state = 'in_flight' AND dispatched_at IS NULL`,
				nowMs, nowMs, outcome.OccurrenceID)
			return err
		}
		if outcome.ErrorCode == "" {
			return fmt.Errorf("%w: error code is required on failure", ErrInvalidInput)
		}
		delivery, err := deliveryByIDTx(ctx, tx, attempt.DeliveryID)
		if err != nil || delivery == nil {
			return fmt.Errorf("reload delivery: %w", err)
		}
		if !outcome.Recoverable {
			if err := cancelDeliveryTx(ctx, tx, delivery, outcome.ErrorCode, nowMs); err != nil {
				return err
			}
			ok, err := terminateAttemptTx(ctx, tx, attempt.OccurrenceID, TerminalSendFailed, attempt.Revision, nowMs)
			if err != nil {
				return err
			}
			if !ok {
				return ErrConcurrentModification
			}
			return nil
		}
		// Recoverable: back to pending with persistent backoff; the occurrence
		// stays open for same-identity reuse.
		return transitionDeliveryTx(ctx, tx, delivery, DeliveryTransition{
			State:         StatePending,
			NextAttemptAt: nowMs + jitteredBackoff(delivery.ID, delivery.RetryCount).Milliseconds(),
			ErrorCode:     nullableString(outcome.ErrorCode),
		}, nowMs)
	})
}

// DeliveryTransition is one CAS delivery-state change.
type DeliveryTransition struct {
	State          string
	RetryCount     *int64
	NextAttemptAt  int64 // used when > 0
	HasNextAttempt bool
	LeaseExpiresAt sql.NullInt64
	ErrorCode      sql.NullString
}

func transitionDeliveryTx(ctx context.Context, ex Executor, d *Delivery, t DeliveryTransition, nowMs int64) error {
	next := t.NextAttemptAt
	hasNext := t.HasNextAttempt
	if !hasNext && t.State == StatePending {
		hasNext = true
	}
	res, err := ex.ExecContext(ctx, `UPDATE agent_deliveries
		SET scheduling_state = ?, next_attempt_at = ?, lease_expires_at = ?, last_error_code = ?,
		    retry_count = COALESCE(?, retry_count), revision = revision + 1, updated_at = ?
		WHERE id = ? AND revision = ?`,
		t.State, next, t.LeaseExpiresAt, t.ErrorCode, t.RetryCount, nowMs, d.ID, d.Revision)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConcurrentModification
	}
	d.SchedulingState = t.State
	d.Revision++
	d.UpdatedAt = nowMs
	if t.RetryCount != nil {
		d.RetryCount = *t.RetryCount
	}
	d.LeaseExpiresAt = t.LeaseExpiresAt
	if hasNext {
		d.NextAttemptAt = next
	}
	if t.ErrorCode.Valid {
		d.LastErrorCode = t.ErrorCode
	}
	return nil
}

// markWaitingTx moves a delivery to a waiting state WITHOUT consuming budget.
func markWaitingTx(ctx context.Context, ex Executor, d *Delivery, state, code string, nowMs int64) error {
	return transitionDeliveryTx(ctx, ex, d, DeliveryTransition{
		State:          state,
		NextAttemptAt:  nowMs + WaitingRecheckBackoff.Milliseconds(),
		HasNextAttempt: true,
		ErrorCode:      nullableString(code),
	}, nowMs)
}

// blockDeliveryTx marks a blocked (diagnosable, explicitly requeueable) state.
func blockDeliveryTx(ctx context.Context, ex Executor, d *Delivery, code string, nowMs int64) error {
	return transitionDeliveryTx(ctx, ex, d, DeliveryTransition{
		State:     StateBlocked,
		ErrorCode: nullableString(code),
	}, nowMs)
}

// cancelDeliveryTx cancels every non-terminal state. Acknowledged rows are
// never touched (an earlier receipt stays true even after revocation).
func cancelDeliveryTx(ctx context.Context, ex Executor, d *Delivery, reason string, nowMs int64) error {
	if d.SchedulingState == StateAcknowledged || d.SchedulingState == StateCancelled {
		return nil
	}
	return transitionDeliveryTx(ctx, ex, d, DeliveryTransition{
		State:     StateCancelled,
		ErrorCode: nullableString(reason),
	}, nowMs)
}

// loadDueDeliveriesTx selects the scan candidates: waiting/pending rows whose
// next attempt is due, plus leased rows whose lease expired.
func loadDueDeliveriesAfterTx(ctx context.Context, ex Executor, nowMs, afterOrder int64, limit int) ([]Delivery, error) {
	rows, err := ex.QueryContext(ctx, `SELECT `+deliveryColumns+` FROM agent_deliveries
		WHERE delivery_order > ? AND (
		   (scheduling_state IN ('pending','waiting_machine','waiting_identity') AND next_attempt_at <= ?)
		   OR (scheduling_state = 'leased' AND lease_expires_at <= ?))
		ORDER BY delivery_order LIMIT ?`, afterOrder, nowMs, nowMs, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// recoverExpiredLeasesTx normalizes expired leases to re-preparable pending
// rows without consuming budget and without pretending a machine is online.
func recoverExpiredLeasesTx(ctx context.Context, ex Executor, nowMs int64) (RecoveredLeases, error) {
	var result RecoveredLeases
	// Managed leases: leased rows whose lease expired. The open occurrence is
	// kept for same-identity reuse at the next prepare.
	rows, err := ex.QueryContext(ctx, `SELECT `+deliveryColumns+` FROM agent_deliveries
		WHERE scheduling_state = 'leased' AND lease_expires_at <= ?`, nowMs)
	if err != nil {
		return result, err
	}
	var leased []Delivery
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			rows.Close()
			return result, err
		}
		leased = append(leased, *d)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return result, err
	}
	rows.Close()
	for i := range leased {
		d := leased[i]
		external := false
		open, err := openAttemptForDeliveryTx(ctx, ex, d.ID)
		if err != nil {
			return result, err
		}
		if open != nil && open.TransportKind == TransportExternalClaim {
			external = true
		}
		if err := transitionDeliveryTx(ctx, ex, &d, DeliveryTransition{
			State:          StatePending,
			NextAttemptAt:  nowMs,
			HasNextAttempt: true,
			ErrorCode:      nullableString(TerminalLeaseExpired),
		}, nowMs); err != nil {
			return result, err
		}
		if external {
			result.Claims++
		} else {
			result.Managed++
		}
	}
	return result, nil
}
