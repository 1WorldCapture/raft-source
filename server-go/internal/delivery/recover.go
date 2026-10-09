package delivery

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// RecoveredLeases counts what one recovery pass normalized.
type RecoveredLeases struct {
	Managed int64
	Claims  int64
}

// RecoverExpiredLeases turns expired process leases into re-preparable
// pending rows. It is the startup/periodic entry: expired leases become
// re-claimable, but nothing pretends a machine is online and no budget is
// reset. The open occurrence of a managed lease is kept so a same-identity
// resend still reuses it.
func (s *Store) RecoverExpiredLeases(ctx context.Context, now time.Time) (RecoveredLeases, error) {
	if now.IsZero() {
		now = s.now()
	}
	nowMs := now.UnixMilli()
	var result RecoveredLeases
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		recovered, err := recoverExpiredLeasesTx(ctx, tx, nowMs)
		if err != nil {
			return err
		}
		result = recovered
		return nil
	})
	return result, err
}

// CancelInput selects the intents to cancel. Every filter is optional except
// WorkspaceID; Reason is a required short stable code recorded on the rows.
type CancelInput struct {
	WorkspaceID    string
	AgentID        string
	ConversationID string
	MessageID      string
	DeliveryID     string
	Reason         string
}

// CancelDeliveries cancels non-terminal intents (revoked membership, deleted
// agent, hidden channel, workspace cleanup). Acknowledged rows never change:
// a receipt that was true before revocation stays true. Cancelled is
// idempotent. Already-delivered bytes are not recalled (best-effort purge is
// the original agent:inbox:purge path, not a revocation guarantee).
func (s *Store) CancelDeliveries(ctx context.Context, input CancelInput) (int64, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.Reason = strings.TrimSpace(input.Reason)
	if input.WorkspaceID == "" {
		return 0, fmt.Errorf("%w: workspace is required", ErrInvalidInput)
	}
	if input.Reason == "" {
		return 0, fmt.Errorf("%w: reason is required", ErrInvalidInput)
	}
	nowMs := s.nowMs()
	var cancelled int64
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		// Terminal-close the open attempts of the selected rows first so the
		// cancel verdict and the attempt verdict commit together.
		targets, err := selectCancellableTx(ctx, tx, input)
		if err != nil {
			return err
		}
		for i := range targets {
			d := targets[i]
			if err := terminalCloseOpenAttemptTx(ctx, tx, d.ID, TerminalCancelled, nowMs); err != nil {
				return err
			}
			if err := cancelDeliveryTx(ctx, tx, &d, input.Reason, nowMs); err != nil {
				return err
			}
			cancelled++
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return cancelled, nil
}

func selectCancellableTx(ctx context.Context, ex Executor, input CancelInput) ([]Delivery, error) {
	query := `SELECT ` + deliveryColumns + ` FROM agent_deliveries
		WHERE workspace_id = ? AND scheduling_state NOT IN ('acknowledged','cancelled')`
	args := []any{input.WorkspaceID}
	if input.AgentID != "" {
		query += ` AND agent_id = ?`
		args = append(args, input.AgentID)
	}
	if input.ConversationID != "" {
		query += ` AND conversation_id = ?`
		args = append(args, input.ConversationID)
	}
	if input.MessageID != "" {
		query += ` AND message_id = ?`
		args = append(args, input.MessageID)
	}
	if input.DeliveryID != "" {
		query += ` AND id = ?`
		args = append(args, input.DeliveryID)
	}
	rows, err := ex.QueryContext(ctx, query, args...)
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

// RequeueBlocked explicitly redrives one blocked delivery: blocked -> pending
// with the retry budget RESET and the operator reason recorded. This is the
// ONLY code path that resets the persistent budget — restarts, reconnects
// and scans never do.
func (s *Store) RequeueBlocked(ctx context.Context, workspaceID, deliveryID, reason string) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	deliveryID = strings.TrimSpace(deliveryID)
	reason = strings.TrimSpace(reason)
	if workspaceID == "" || deliveryID == "" {
		return false, fmt.Errorf("%w: workspace and delivery are required", ErrInvalidInput)
	}
	if reason == "" {
		reason = "operator_redrive"
	}
	nowMs := s.nowMs()
	requeued := false
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		d, err := deliveryByIDTx(ctx, tx, deliveryID)
		if err != nil {
			return err
		}
		if d == nil || d.WorkspaceID != workspaceID {
			return ErrNotFound
		}
		if d.SchedulingState != StateBlocked {
			return ErrNotBlocked
		}
		// The blocked intent may still have the observed occurrence open
		// (uncertain identity drift). Clearing state and budget alone makes
		// the next prepare see that same observation and block again. Close
		// it as SUPERSEDED — not ACKED — so observation timestamps remain,
		// acked_at is not invented, and a stale five-tuple cannot complete
		// the replacement occurrence minted on the next prepare.
		if err := terminalCloseOpenAttemptTx(ctx, tx, d.ID, TerminalSuperseded, nowMs); err != nil {
			return err
		}
		zero := int64(0)
		if err := transitionDeliveryTx(ctx, tx, d, DeliveryTransition{
			State:          StatePending,
			RetryCount:     &zero,
			NextAttemptAt:  nowMs,
			HasNextAttempt: true,
			ErrorCode:      nullableString("redriven:" + reason),
		}, nowMs); err != nil {
			return err
		}
		requeued = true
		return nil
	})
	return requeued, err
}
