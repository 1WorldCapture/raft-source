// Setup persistence and commands — the write side of the setup state machine.
//
// Port of the TS command surface:
//   - createServerSetupStateService.resolveServerSetup / .transitionServerSetupState
//   - resetServerSetup ("Start over")
//   - the setup-handoff route + markSetupHandoffAcknowledged ("Let's Go")
//   - reconcileOwnersToSetupCheckpoint + the onboarding-agent setter check
//     (helpers consumed by the settings worker's transaction)
//
// Invariants that are deliberate and must not be "unified" away:
//   - transitions are for the OWNER by membership role; reset/handoff are
//     authorized by the workspace ownerId instead (legacy asymmetry, D06);
//   - handoff has NO complete-status prerequisite and never advances
//     setup.status — it only records first facts;
//   - reset checks the checkpoint (onboardingAgentId) itself, inside the
//     same transaction as the destruction, never a projected column;
//   - the authorized onboarding-agent setter crosses the checkpoint with a
//     grandfathered reconcile that does NOT repeat the official-identity
//     check (D11) — different rule from explicit complete.
package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// GetSetupState reads the persisted setup row for one membership. nil, nil
// means "no row" (TS repository.get → null).
func (s *Store) GetSetupState(ctx context.Context, workspaceID, userID string) (*SetupState, error) {
	return s.readSetupState(ctx, s.db, workspaceID, userID)
}

// readSetupState is the row projection shared by every command path.
func (s *Store) readSetupState(ctx context.Context, ex executor, workspaceID, userID string) (*SetupState, error) {
	var state SetupState
	var reason sql.NullString
	err := ex.QueryRowContext(ctx, `
		SELECT status, completion_reason, contract_version
		FROM workspace_member_setup
		WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID).
		Scan(&state.Status, &reason, &state.ContractVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read setup state: %w", err)
	}
	if reason.Valid {
		v := reason.String
		state.CompletionReason = &v
	}
	state.WorkspaceID = workspaceID
	state.UserID = userID
	return &state, nil
}

// GetSetupProjection ports resolveServerSetup. It NEVER returns a business
// error: every unauthorized/unresolvable situation renders as the reference
// no-setup or retry projection (the legacy GET always answers 200). Only an
// infrastructure failure returns an error (transport: 500).
func (s *Store) GetSetupProjection(ctx context.Context, workspaceID, userID string) (SetupProjection, error) {
	// Role resolution: TS getMemberRole — deleted workspaces lose roles,
	// roles come from the real membership row. Setup flow belongs to the
	// owner only; an admin helping out must not receive the owner's wizard,
	// survey or handoff.
	role, err := s.memberRole(ctx, s.db, workspaceID, userID)
	if err != nil {
		return RetryProjection(nil, GateReasonResolverError), nil
	}
	if role != RoleOwner {
		return NoSetupProjection(GateReasonInsufficientPermission), nil
	}

	state, err := s.GetSetupState(ctx, workspaceID, userID)
	if err != nil {
		return RetryProjection(nil, GateReasonResolverError), nil
	}
	if state == nil {
		return RetryProjection(nil, GateReasonStateNotFound), nil
	}

	if state.Status == SetupStatusComplete {
		// Terminal: do NOT re-read live machine inventory (D09) — computer
		// facts degrade to unknown, everHadAgent fails closed. The survey and
		// handoff may still be owed, so post-setup facts ARE read.
		facts, err := s.ResolvePersistedCompletionFacts(ctx, s.db, workspaceID, userID)
		if err != nil {
			phase := state.Status
			return RetryProjection(&phase, GateReasonResolverError), nil
		}
		return ProjectServerSetup(*state, facts), nil
	}

	facts, err := s.ResolveSetupLiveFacts(ctx, s.db, workspaceID, userID)
	if err != nil {
		phase := state.Status
		return RetryProjection(&phase, GateReasonResolverError), nil
	}
	return ProjectServerSetup(*state, facts), nil
}

// assertSetupMutationAuthority ports assertMutationAuthority: actor must be
// human (guaranteed by the single-userId signature), may only act as them-
// selves (same), and must hold the OWNER membership role. A role-lookup
// failure is INSUFFICIENT_PERMISSION here — unlike the projection path,
// where it renders as retry (TS asymmetry preserved).
func (s *Store) assertSetupMutationAuthority(ctx context.Context, workspaceID, userID string) error {
	role, err := s.memberRole(ctx, s.db, workspaceID, userID)
	if err != nil {
		return &DomainError{Code: CodeInsufficientPermission, Message: "Could not verify server setup authority"}
	}
	if role != RoleOwner {
		return &DomainError{Code: CodeInsufficientPermission, Message: "Server setup belongs to the server owner"}
	}
	return nil
}

// TransitionSetup ports transitionServerSetupState for actions start|complete
// (defer is retired: 400 INVALID_SETUP_ACTION). start is idempotent and can
// never regress complete; complete requires the official onboarding agent to
// be usable unless already complete, and every fresh completion is reason
// normal. The returned projection is re-read after the commit (legacy W13).
func (s *Store) TransitionSetup(ctx context.Context, workspaceID, userID, action string) (SetupProjection, error) {
	if action != SetupActionStart && action != SetupActionComplete {
		return SetupProjection{}, &DomainError{Code: CodeInvalidSetupAction, Message: "INVALID_SETUP_ACTION"}
	}
	if err := s.assertSetupMutationAuthority(ctx, workspaceID, userID); err != nil {
		return SetupProjection{}, err
	}

	if action == SetupActionComplete {
		current, err := s.GetSetupState(ctx, workspaceID, userID)
		if err != nil {
			return SetupProjection{}, &DomainError{Code: CodeLiveFactsUnavailable, Message: "Could not verify official onboarding agent state"}
		}
		if current == nil {
			return SetupProjection{}, &DomainError{Code: CodeStateNotFound, Message: "Server setup state was not found"}
		}
		if current.Status != SetupStatusComplete {
			// The usable check is the persisted official-agent definition —
			// pointer, local, not deleted, machine-bound, non-empty runtime,
			// official identity + admin server role. It is NOT "an agent is
			// online" (R19).
			state, err := s.resolveOfficialAgentState(ctx, s.db, workspaceID)
			if err != nil {
				return SetupProjection{}, &DomainError{Code: CodeLiveFactsUnavailable, Message: "Could not verify official onboarding agent state"}
			}
			if state != OfficialAgentStateUsable {
				return SetupProjection{}, &DomainError{
					Code:    CodeOfficialOnboardingAgentNotUsable,
					Message: "Server setup cannot complete until the official onboarding agent is usable",
				}
			}
		}
	}

	// The repository transition: one transaction, re-read, mutate only when
	// the state actually changes (SQLite IMMEDIATE serializes the row).
	transitionErr := s.withTx(ctx, func(tx *sql.Tx) error {
		current, err := s.readSetupState(ctx, tx, workspaceID, userID)
		if err != nil {
			return err
		}
		if current == nil {
			return &DomainError{Code: CodeStateNotFound, Message: "Server setup state was not found"}
		}
		next := NextSetupStateForAction(*current, action)
		if setupStatesEqual(*current, next) {
			return nil
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE workspace_member_setup
			SET status = ?, completion_reason = ?
			WHERE workspace_id = ? AND user_id = ?`,
			next.Status, nullableString(next.CompletionReason), workspaceID, userID)
		if err != nil {
			return fmt.Errorf("write setup transition: %w", err)
		}
		return nil
	})
	if transitionErr != nil {
		return SetupProjection{}, transitionErr
	}
	return s.GetSetupProjection(ctx, workspaceID, userID)
}

func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}

func setupStatesEqual(a, b SetupState) bool {
	return a.WorkspaceID == b.WorkspaceID && a.UserID == b.UserID &&
		a.Status == b.Status && a.ContractVersion == b.ContractVersion &&
		nullableString(a.CompletionReason) == nullableString(b.CompletionReason)
}

// SetupResetResult carries the reset outcome. The legacy response spreads the
// fresh projection and reports revokedComputers, so Projection rides along
// for the transport to merge (it is not part of the wire object itself).
type SetupResetResult struct {
	Projection       SetupProjection `json:"-"`
	RevokedComputers int             `json:"revokedComputers"`
}

// ResetSetup ports resetServerSetup ("Start over"). Authorization is the
// workspace OWNERID match — not the membership role (legacy asymmetry).
// Every guard and both destructive writes share one transaction: either an
// agent creation commits first and reset refuses, or reset commits first.
// complete and any onboarding-agent pointer are terminal (the commit point);
// nothing else is touched — no member, channel or profile deletion.
func (s *Store) ResetSetup(ctx context.Context, workspaceID, userID string) (SetupResetResult, error) {
	result := SetupResetResult{}
	var revokedMachines []string
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		var ownerID string
		var onboardingAgentID sql.NullString
		err := tx.QueryRowContext(ctx, `
			SELECT owner_id, onboarding_agent_id FROM workspaces
			WHERE id = ? AND deleted_at IS NULL`, workspaceID).
			Scan(&ownerID, &onboardingAgentID)
		if errors.Is(err, sql.ErrNoRows) {
			return &DomainError{Code: CodeStateNotFound, Message: "Server not found"}
		}
		if err != nil {
			return fmt.Errorf("read workspace for reset: %w", err)
		}
		// The owner's flow, and the owner's workspace: an admin may help set
		// a workspace up, they may not throw someone else's away.
		if ownerID != userID {
			return &DomainError{Code: CodeInsufficientPermission, Message: "Only the owner may reset setup"}
		}

		// `complete` is terminal and includes the reset path.
		ownerState, err := s.readSetupState(ctx, tx, workspaceID, ownerID)
		if err != nil {
			return err
		}
		if ownerState != nil && ownerState.Status == SetupStatusComplete {
			return &DomainError{Code: CodeServerAlreadySetUp, Message: "Setup is complete; it cannot be rolled back"}
		}

		// The guard: the workspace's official onboarding-agent pointer, not
		// any setup_status projection and not unrelated bootstrap agents.
		if onboardingAgentID.Valid && onboardingAgentID.String != "" {
			return &DomainError{Code: CodeServerAlreadySetUp, Message: "This server has had an onboarding agent; setup cannot be rolled back"}
		}

		if s.onComputerRevoked != nil {
			// Capture exactly the live attachments being revoked, not every
			// machine in the workspace. Disconnect only after commit, and do
			// not let a corrupt foreign binding affect another workspace.
			rows, err := tx.QueryContext(ctx, `
				SELECT DISTINCT c.machine_id
				FROM computers c JOIN machines m
				  ON m.id = c.machine_id AND m.workspace_id = c.workspace_id
				WHERE c.workspace_id = ? AND c.revoked_at IS NULL
				ORDER BY c.machine_id`, workspaceID)
			if err != nil {
				return fmt.Errorf("read reset computer bindings: %w", err)
			}
			for rows.Next() {
				var machineID string
				if err := rows.Scan(&machineID); err != nil {
					_ = rows.Close()
					return fmt.Errorf("read reset machine id: %w", err)
				}
				revokedMachines = append(revokedMachines, machineID)
			}
			readErr := rows.Err()
			closeErr := rows.Close()
			if readErr != nil {
				return fmt.Errorf("read reset machines: %w", readErr)
			}
			if closeErr != nil {
				return fmt.Errorf("close reset machines: %w", closeErr)
			}
		}

		revokedAt := s.now().UnixMilli()
		res, err := tx.ExecContext(ctx, `
			UPDATE computers SET revoked_at = ?
			WHERE workspace_id = ? AND revoked_at IS NULL`, revokedAt, workspaceID)
		if err != nil {
			return fmt.Errorf("revoke computers: %w", err)
		}
		revoked, err := res.RowsAffected()
		if err != nil {
			return fmt.Errorf("count revoked computers: %w", err)
		}
		result.RevokedComputers = int(revoked)

		_, err = tx.ExecContext(ctx, `
			UPDATE workspace_member_setup
			SET status = ?, completion_reason = NULL
			WHERE workspace_id = ? AND user_id = ?`,
			SetupStatusNotStarted, workspaceID, ownerID)
		if err != nil {
			return fmt.Errorf("reset owner setup state: %w", err)
		}
		return nil
	})
	if err != nil {
		return SetupResetResult{}, err
	}
	for _, machineID := range revokedMachines {
		s.onComputerRevoked(machineID)
	}
	projection, err := s.GetSetupProjection(ctx, workspaceID, userID)
	if err != nil {
		return SetupResetResult{}, err
	}
	result.Projection = projection
	return result, nil
}

// HandoffSetup ports the legacy setup-handoff route: "Let's Go" is a COMMAND
// with its own durable fact. Authorized by the workspace OWNERID match; it
// deliberately has NO complete-status prerequisite (D06) and never advances
// setup.status. The first acknowledgment and the account-level first-
// onboarding facts are first-write-wins: pressing twice — or retrying after
// a dropped response — keeps the first timestamp. M2 records the click only;
// briefing delivery belongs to the later agent runtime and is never claimed.
func (s *Store) HandoffSetup(ctx context.Context, workspaceID, userID, sessionFamilyID string) (SetupProjection, error) {
	var ownerID string
	err := s.db.QueryRowContext(ctx, `
		SELECT owner_id FROM workspaces
		WHERE id = ? AND deleted_at IS NULL`, workspaceID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return SetupProjection{}, &DomainError{Code: CodeNotFound, Message: "Server not found"}
	}
	if err != nil {
		return SetupProjection{}, fmt.Errorf("read workspace for handoff: %w", err)
	}
	if ownerID != userID {
		return SetupProjection{}, &DomainError{Code: CodeInsufficientPermission, Message: "INSUFFICIENT_PERMISSION"}
	}

	now := s.now().UnixMilli()
	err = s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workspace_member_setup
			SET handoff_acknowledged_at = ?
			WHERE workspace_id = ? AND user_id = ? AND handoff_acknowledged_at IS NULL`,
			now, workspaceID, userID); err != nil {
			return fmt.Errorf("stamp handoff acknowledgment: %w", err)
		}
		var family any
		if sessionFamilyID != "" {
			family = sessionFamilyID
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE users
			SET first_onboarding_completed_at = ?,
			    first_onboarding_completed_session_family_id = ?,
			    updated_at = ?
			WHERE id = ? AND first_onboarding_completed_at IS NULL`,
			now, family, now, userID); err != nil {
			return fmt.Errorf("stamp account first onboarding: %w", err)
		}
		return nil
	})
	if err != nil {
		return SetupProjection{}, err
	}
	return s.GetSetupProjection(ctx, workspaceID, userID)
}

// validateConfiguredAgentTx is the onboarding-settings setter rule (R23):
// a non-empty onboardingAgentId must resolve to a real, same-workspace,
// not-deleted agent row. It deliberately accepts ANY such local agent —
// official Cindy identity is NOT re-checked on this path (that rule belongs
// to explicit setup complete only; D11). Settings calls it inside its own
// transaction and maps the failure to the W11 400 sentence.
func validateConfiguredAgentTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID string) error {
	if agentID == "" {
		return &DomainError{Code: CodeInvalidInput, Message: "Onboarding agent not found in this server"}
	}
	var one int
	err := tx.QueryRowContext(ctx, `
		SELECT 1 FROM agents
		WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		agentID, workspaceID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return &DomainError{Code: CodeInvalidInput, Message: "Onboarding agent not found in this server"}
	}
	if err != nil {
		return fmt.Errorf("validate onboarding agent: %w", err)
	}
	return nil
}

// reconcileOwnersTx ports reconcileOwnersToSetupCheckpoint: once a workspace
// crossed the checkpoint (onboarding_agent_id set — the same fact the
// projection reads as everHadAgent), every OWNER membership must be complete.
// Already-complete rows keep their original reason (the original owner's
// `normal` survives); newly reconciled owners are `grandfathered` — they
// never onboarded, so they are not owed the post-setup survey/handoff
// either. Runs inside the caller's transaction (no nested tx).
func reconcileOwnersTx(ctx context.Context, tx *sql.Tx, workspaceID string) error {
	var onboardingAgentID sql.NullString
	err := tx.QueryRowContext(ctx, `
		SELECT onboarding_agent_id FROM workspaces
		WHERE id = ? AND deleted_at IS NULL`, workspaceID).Scan(&onboardingAgentID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read workspace for owner reconcile: %w", err)
	}
	if !onboardingAgentID.Valid || onboardingAgentID.String == "" {
		return nil
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE workspace_member_setup
		SET status = ?, completion_reason = ?
		WHERE workspace_id = ? AND status <> ?
		  AND user_id IN (SELECT user_id FROM workspace_memberships
		                  WHERE workspace_id = ? AND role = ?)`,
		SetupStatusComplete, SetupReasonGrandfathered, workspaceID, SetupStatusComplete,
		workspaceID, RoleOwner)
	if err != nil {
		return fmt.Errorf("reconcile owner setup rows: %w", err)
	}
	return nil
}
