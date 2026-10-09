package delivery

import (
	"context"
	"database/sql"
	"fmt"
)

// FindPlannedSourceTx returns the exact logical intent for a known source on
// the caller's snapshot/transaction. The caller already owns the source facts
// and must check their authority; this is not a public unscoped queue API.
// Onboarding uses it to reconcile a durable reported receipt into the existing
// workspace preference without creating a second outbox or an ACK cache.
func (s *Store) FindPlannedSourceTx(ctx context.Context, ex Executor, workspaceID, agentID, sourceKind, sourceID string) (*Delivery, error) {
	if ex == nil || workspaceID == "" || agentID == "" || sourceID == "" {
		return nil, fmt.Errorf("delivery: source lookup requires an executor and exact source identity")
	}
	if sourceKind != SourceMessage && sourceKind != SourceBriefing {
		return nil, fmt.Errorf("delivery: unknown source kind")
	}
	d, err := scanDelivery(ex.QueryRowContext(ctx, `SELECT `+deliveryColumns+`
		FROM agent_deliveries
		WHERE workspace_id = ? AND agent_id = ? AND source_kind = ? AND source_id = ?`,
		workspaceID, agentID, sourceKind, sourceID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read planned delivery source: %w", err)
	}
	return d, nil
}
