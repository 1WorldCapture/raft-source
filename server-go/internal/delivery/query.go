package delivery

import (
	"context"
	"fmt"
)

// GetDelivery loads one delivery by id (diagnostics).
func (s *Store) GetDelivery(ctx context.Context, deliveryID string) (*Delivery, error) {
	var out *Delivery
	err := s.withReadSnapshot(ctx, func(ex Executor) error {
		d, err := deliveryByIDTx(ctx, ex, deliveryID)
		if err != nil {
			return err
		}
		out = d
		return nil
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, ErrNotFound
	}
	return out, nil
}

// ListMessageDeliveries returns the intents planned for one message.
func (s *Store) ListMessageDeliveries(ctx context.Context, workspaceID, messageID string) ([]Delivery, error) {
	var out []Delivery
	err := s.withReadSnapshot(ctx, func(ex Executor) error {
		rows, err := ex.QueryContext(ctx,
			`SELECT `+deliveryColumns+` FROM agent_deliveries
			WHERE workspace_id = ? AND message_id = ? ORDER BY agent_id`, workspaceID, messageID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			d, err := scanDelivery(rows)
			if err != nil {
				return err
			}
			out = append(out, *d)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []Delivery{}
	}
	return out, nil
}

// AttemptByOccurrence loads one protocol occurrence (diagnostics).
func (s *Store) AttemptByOccurrence(ctx context.Context, occurrenceID string) (*Attempt, error) {
	var out *Attempt
	err := s.withReadSnapshot(ctx, func(ex Executor) error {
		a, err := attemptByOccurrenceTx(ctx, ex, occurrenceID)
		if err != nil {
			return err
		}
		out = a
		return nil
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, ErrNotFound
	}
	return out, nil
}

// QueueStats is the bounded diagnostic projection for one workspace. It
// counts states and ages only — no bodies, no tokens, no cross-workspace
// backlog exposure.
type QueueStats struct {
	PerState         map[string]int64
	InFlightAttempts int64
	OldestDueAgeMs   int64
	OpenClaims       int64
}

// QueueStats summarizes one workspace's queue.
func (s *Store) QueueStats(ctx context.Context, workspaceID string) (*QueueStats, error) {
	if workspaceID == "" {
		return nil, fmt.Errorf("%w: workspace is required", ErrInvalidInput)
	}
	stats := &QueueStats{PerState: map[string]int64{}}
	err := s.withReadSnapshot(ctx, func(ex Executor) error {
		rows, err := ex.QueryContext(ctx,
			`SELECT scheduling_state, COUNT(*) FROM agent_deliveries WHERE workspace_id = ? GROUP BY scheduling_state`,
			workspaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var state string
			var count int64
			if err := rows.Scan(&state, &count); err != nil {
				return err
			}
			stats.PerState[state] = count
		}
		if err := rows.Err(); err != nil {
			return err
		}
		nowMs := s.nowMs()
		if err := ex.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM agent_delivery_attempts a
			 JOIN agent_deliveries d ON d.id = a.delivery_id
			 WHERE d.workspace_id = ? AND a.state = 'in_flight'`, workspaceID).
			Scan(&stats.InFlightAttempts); err != nil {
			return err
		}
		var oldestDue int64
		if err := ex.QueryRowContext(ctx,
			`SELECT COALESCE(MIN(next_attempt_at), 0) FROM agent_deliveries
			 WHERE workspace_id = ? AND scheduling_state IN ('pending','waiting_machine','waiting_identity')
			   AND next_attempt_at <= ?`, workspaceID, nowMs).Scan(&oldestDue); err != nil {
			return err
		}
		if oldestDue > 0 {
			stats.OldestDueAgeMs = nowMs - oldestDue
		}
		return ex.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM agent_delivery_claims
			WHERE workspace_id = ? AND acked_at IS NULL AND lease_expires_at > ?`,
			workspaceID, nowMs).Scan(&stats.OpenClaims)
	})
	if err != nil {
		return nil, err
	}
	return stats, nil
}
