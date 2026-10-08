package workspace

import (
	"context"
	"fmt"
)

// applyLiveMachinePresence enriches the persisted catalog with this server's
// connection authority. GET never writes timestamps/status to manufacture a
// heartbeat. With no provider, M2's honest offline directory remains intact.
func (s *Store) applyLiveMachinePresence(ctx context.Context, row machineDirectoryRow, model map[string]any) error {
	if s.machineStatusProbe == nil {
		return nil
	}
	online, err := s.probeMachineStatus(ctx, row.ID)
	if err != nil {
		return fmt.Errorf("resolve live machine directory status: %w", err)
	}
	if !online {
		model["status"] = ComputerStateOffline
		model["statusSince"] = deriveStatusSince(row)
		return nil
	}
	model["status"] = ComputerStateOnline
	// Exact online branch of TS deriveMachineStatusSince: use the recorded
	// matching transition only; a heartbeat or the current time is not it.
	model["statusSince"] = nil
	if row.LastStatus.Valid && row.LastStatus.String == ComputerStateOnline && row.StatusChangedAt.Valid {
		model["statusSince"] = row.StatusChangedAt.Int64
	}
	return nil
}
