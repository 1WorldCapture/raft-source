// SQLite persistence for the agent slice. All timestamps are unix
// milliseconds; every write runs inside one IMMEDIATE transaction so the
// onboarding checkpoint commits with the fact it attests (see CreateAgent).
package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
)

// Store reads and writes agent tables.
type Store struct {
	db            *sql.DB
	clock         clock.Clock
	hasher        *CredentialHasher
	openerEnabled bool
	selfHosted    bool
	// afterSlowSecret runs after argon2id (or the bootstrap HMAC verify) and
	// before the following read or write transaction. Production leaves it
	// nil. Tests use it to revoke or delete between the slow step and the
	// recheck, which is the race the recheck exists to close.
	afterSlowSecret func()
}

// StoreOptions injects the clock, credential hasher and the frozen
// opener-v2 policy (the #all reveal gate mirrors workspace.Policy).
type StoreOptions struct {
	Clock                   clock.Clock
	Hasher                  *CredentialHasher
	OnboardingOpenerV2      bool
	SelfHostedRunnerEnabled bool
}

// NewStore builds the store. The database must already be migrated (0008).
func NewStore(handle *sql.DB, opts StoreOptions) *Store {
	s := &Store{
		db:            handle,
		clock:         opts.Clock,
		hasher:        opts.Hasher,
		openerEnabled: opts.OnboardingOpenerV2,
		selfHosted:    opts.SelfHostedRunnerEnabled,
	}
	if s.clock == nil {
		s.clock = clock.Real{}
	}
	return s
}

// SelfHostedRunnerEnabled reports the frozen bootstrap-surface gate
// (TS SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED).
func (s *Store) SelfHostedRunnerEnabled() bool { return s.selfHosted }

func (s *Store) now() int64 { return s.clock.Now().UnixMilli() }

// noteSlowSecret is the test seam between a slow secret operation and the
// short transaction that rechecks live state. It must never run while a
// write transaction is open.
func (s *Store) noteSlowSecret() {
	if s.afterSlowSecret != nil {
		s.afterSlowSecret()
	}
}

type executor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func (s *Store) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	// Onboarding may reveal/create channels. Publish those authority changes
	// under the same M4 admission fence without changing the M3 wire protocol.
	return db.WithWriteTx(ctx, s.db, fn)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const agentColumns = `a.id, a.workspace_id, a.name, a.display_name, a.description,
	a.avatar_url, a.status, a.status_changed_at, a.session_id, a.model, a.runtime,
	a.runtime_config, a.reasoning_effort, a.execution_mode, a.env_vars,
	a.creator_type, a.creator_id, a.machine_id, a.deleted_at, a.created_at, a.updated_at`

func scanAgent(row interface{ Scan(...any) error }) (*Agent, error) {
	var a Agent
	// json.RawMessage is jsontext.Value. database/sql cannot store SQL NULL
	// into that named slice, so nullable JSON columns scan through NullString.
	var runtimeConfig, envVars sql.NullString
	err := row.Scan(&a.ID, &a.WorkspaceID, &a.Name, &a.DisplayName, &a.Description,
		&a.AvatarURL, &a.Status, &a.StatusChangedAt, &a.SessionID, &a.Model, &a.Runtime,
		&runtimeConfig, &a.ReasoningEffort, &a.ExecutionMode, &envVars,
		&a.CreatorType, &a.CreatorID, &a.MachineID, &a.DeletedAt, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if runtimeConfig.Valid {
		a.RuntimeConfig = json.RawMessage(runtimeConfig.String)
	}
	if envVars.Valid {
		a.EnvVars = json.RawMessage(envVars.String)
	}
	return &a, nil
}

// GetAgent loads one agent by id. includeDeleted mirrors getAgent(id, true).
func (s *Store) GetAgent(ctx context.Context, id string, includeDeleted bool) (*Agent, error) {
	query := `SELECT ` + agentColumns + ` FROM agents a WHERE a.id = ?`
	if !includeDeleted {
		query += ` AND a.deleted_at IS NULL`
	}
	agent, err := scanAgent(s.db.QueryRowContext(ctx, query, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read agent: %w", err)
	}
	return agent, nil
}

// ListAgents lists a workspace's agents ordered by created_at (TS listAgents).
func (s *Store) ListAgents(ctx context.Context, workspaceID string, includeDeleted bool) ([]*Agent, error) {
	query := `SELECT ` + agentColumns + ` FROM agents a WHERE a.workspace_id = ?`
	if !includeDeleted {
		query += ` AND a.deleted_at IS NULL`
	}
	query += ` ORDER BY a.created_at ASC`
	rows, err := s.db.QueryContext(ctx, query, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list agents: %w", err)
	}
	defer rows.Close()
	var out []*Agent
	for rows.Next() {
		agent, err := scanAgent(rows)
		if err != nil {
			return nil, fmt.Errorf("scan agent: %w", err)
		}
		out = append(out, agent)
	}
	return out, rows.Err()
}

// AgentMemberRole reads the agent's server membership role (null when absent).
func (s *Store) AgentMemberRole(ctx context.Context, workspaceID, agentID string) (*string, error) {
	var role string
	err := s.db.QueryRowContext(ctx,
		`SELECT role FROM agent_members WHERE workspace_id = ? AND agent_id = ?`,
		workspaceID, agentID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read agent member role: %w", err)
	}
	return &role, nil
}

// MemberRole reads a human membership role; nil when the caller is not a
// member of a live (non-deleted, non-joint) workspace — requireServer's rule.
func (s *Store) MemberRole(ctx context.Context, workspaceID, userID string) (*string, error) {
	var role string
	err := s.db.QueryRowContext(ctx, `
		SELECT m.role FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ?
		  AND w.deleted_at IS NULL AND w.kind != 'joint_storage'`,
		workspaceID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read member role: %w", err)
	}
	return &role, nil
}

// Machine is the slice of the machines row lifecycle commands need.
type Machine struct {
	ID          string
	WorkspaceID string
	Name        string
	Description sql.NullString
	Hostname    sql.NullString
	OS          sql.NullString
	DaemonVer   sql.NullString
}

// GetMachine loads one machine of a workspace.
func (s *Store) GetMachine(ctx context.Context, workspaceID, machineID string) (*Machine, error) {
	var m Machine
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, name, description, hostname, os, daemon_version
		FROM machines WHERE id = ? AND workspace_id = ?`, machineID, workspaceID).
		Scan(&m.ID, &m.WorkspaceID, &m.Name, &m.Description, &m.Hostname, &m.OS, &m.DaemonVer)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read machine: %w", err)
	}
	return &m, nil
}

// FirstMachine returns the first machine of the workspace (auto-assign).
func (s *Store) firstMachine(ctx context.Context, q executor, workspaceID string) (*string, error) {
	var id string
	err := q.QueryRowContext(ctx,
		`SELECT id FROM machines WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
		workspaceID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read first machine: %w", err)
	}
	return &id, nil
}

// OnboardingAgentID reads the workspace checkpoint pointer.
func (s *Store) OnboardingAgentID(ctx context.Context, workspaceID string) (*string, error) {
	var pointer sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT onboarding_agent_id FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
		workspaceID).Scan(&pointer)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read onboarding pointer: %w", err)
	}
	if !pointer.Valid || pointer.String == "" {
		return nil, nil
	}
	return &pointer.String, nil
}

// activeAgentNamedCindy mirrors the TS case-insensitive duplicate guard.
func (s *Store) activeAgentNamedCindy(ctx context.Context, q executor, workspaceID string) (bool, error) {
	var count int
	err := q.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM agents
		WHERE workspace_id = ? AND lower(name) = 'cindy' AND deleted_at IS NULL`,
		workspaceID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("count cindy agents: %w", err)
	}
	return count > 0, nil
}

// ownerSetupStatus reads the owner's persisted setup status (the create CAS).
func (s *Store) ownerSetupStatus(ctx context.Context, q executor, workspaceID string) (*string, error) {
	var ownerID string
	var status sql.NullString
	err := q.QueryRowContext(ctx, `
		SELECT u.id, s.status FROM workspaces w
		JOIN users u ON u.id = w.owner_id
		LEFT JOIN workspace_member_setup s
		       ON s.workspace_id = w.id AND s.user_id = w.owner_id
		WHERE w.id = ?`, workspaceID).Scan(&ownerID, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read owner setup status: %w", err)
	}
	if !status.Valid {
		return nil, nil
	}
	return &status.String, nil
}

// ---------------------------------------------------------------------------
// Create — the onboarding checkpoint commits with the agent row
// ---------------------------------------------------------------------------

// CreateAgentInput is the validated create payload.
type CreateAgentInput struct {
	WorkspaceID     string
	Name            string
	Description     *string
	Model           *string
	Runtime         string
	RuntimeConfig   json.RawMessage
	ReasoningEffort *string
	MachineID       *string
	EnvVars         json.RawMessage
	AvatarURL       *string
	CreatorType     string
	CreatorID       string
	Onboarding      bool // official Cindy create
	// ExpectedOwnerSetupStatus is the route's pre-read of the owner's setup
	// row; nil skips the CAS (service callers inside the server).
	ExpectedOwnerSetupStatus *string
}

// CreateAgent inserts the agent plus its membership and, in the SAME
// transaction, every fact the create attests:
//   - auto-assign the first machine when none was supplied (managed runtimes),
//   - reveal #all when the workspace reached team size (opener-v2 policy),
//   - mark the OWNER's setup complete (any first agent; reason=normal),
//   - for the official onboarding agent: set workspaces.onboarding_agent_id
//     and promote the agent membership to admin.
//
// Either all of it commits or none of it does; the SQLite IMMEDIATE
// transaction is the serialization boundary against setup-reset.
func (s *Store) CreateAgent(ctx context.Context, input CreateAgentInput) (*Agent, error) {
	var created *Agent
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		// Create-vs-reset CAS: a create that started before a reset must not
		// resurrect an agent on revoked Computer credentials (TS comments).
		if input.ExpectedOwnerSetupStatus != nil {
			current, err := s.ownerSetupStatus(ctx, tx, input.WorkspaceID)
			if err != nil {
				return err
			}
			if !equalOptional(current, input.ExpectedOwnerSetupStatus) {
				return ErrSetupChangedRetry
			}
		}

		if err := s.assertHandleAvailable(ctx, tx, input.WorkspaceID, input.Name); err != nil {
			return err
		}

		machineID := input.MachineID
		if machineID == nil && !IsExternalAgentRuntime(input.Runtime) {
			first, err := s.firstMachine(ctx, tx, input.WorkspaceID)
			if err != nil {
				return err
			}
			machineID = first
		}

		now := s.now()
		model := DefaultModelForRuntime(input.Runtime)
		if input.Model != nil && *input.Model != "" {
			model = *input.Model
		}
		id := auth.NewUUID()
		_, err := tx.ExecContext(ctx, `
			INSERT INTO agents (id, workspace_id, name, display_name, description, avatar_url,
				status, status_changed_at, runtime, model, runtime_config, reasoning_effort,
				execution_mode, env_vars, creator_type, creator_id, machine_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, 'inactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, input.WorkspaceID, input.Name, input.Name, input.Description, input.AvatarURL,
			now, input.Runtime, model, jsonString(input.RuntimeConfig), sqlNullString(input.ReasoningEffort),
			"byoc", jsonString(input.EnvVars), input.CreatorType, input.CreatorID, machineID, now, now)
		if err != nil {
			if db.IsUniqueViolation(err, "idx_agents_workspace_name") {
				return errf(409, "", "Agent name is already taken")
			}
			return fmt.Errorf("insert agent: %w", err)
		}

		role := "member"
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(workspace_id, agent_id) DO NOTHING`,
			input.WorkspaceID, id, role, now, now); err != nil {
			return fmt.Errorf("insert agent membership: %w", err)
		}

		if err := s.revealAllChannelAtTeamSize(ctx, tx, input.WorkspaceID); err != nil {
			return err
		}

		// "A server with an agent is set up. Say so, durably, IN THE SAME
		// TRANSACTION." Owner-only, idempotent, reason=normal.
		if err := s.markOwnerSetupComplete(ctx, tx, input.WorkspaceID, now); err != nil {
			return err
		}

		if input.Onboarding {
			res, err := tx.ExecContext(ctx,
				`UPDATE workspaces SET onboarding_agent_id = ? WHERE id = ? AND onboarding_agent_id IS NULL`,
				id, input.WorkspaceID)
			if err != nil {
				return fmt.Errorf("set onboarding agent: %w", err)
			}
			if changed, _ := res.RowsAffected(); changed == 0 {
				return errf(409, "", "Onboarding agent already exists in this server")
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE agent_members SET role = 'admin', updated_at = ?
				WHERE workspace_id = ? AND agent_id = ?`, now, input.WorkspaceID, id); err != nil {
				return fmt.Errorf("promote onboarding agent: %w", err)
			}
		}

		agent, err := scanAgent(tx.QueryRowContext(ctx,
			`SELECT `+agentColumns+` FROM agents a WHERE a.id = ?`, id))
		if err != nil {
			return fmt.Errorf("read created agent: %w", err)
		}
		created = agent
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// assertHandleAvailable rejects a name already held by a live agent in the
// workspace (the partial unique index is the final arbiter under races).
func (s *Store) assertHandleAvailable(ctx context.Context, q executor, workspaceID, name string) error {
	var count int
	err := q.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM agents
		WHERE workspace_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL`,
		workspaceID, name).Scan(&count)
	if err != nil {
		return fmt.Errorf("check agent handle: %w", err)
	}
	if count > 0 {
		return errf(409, "", "Agent name is already taken")
	}
	return nil
}

// revealAllChannelAtTeamSize ports the opener-v2 #all reveal: when total
// members (humans + agents) reach 3 and the channel is still private, flip
// it public. Idempotent by the type='private' guard.
func (s *Store) revealAllChannelAtTeamSize(ctx context.Context, q executor, workspaceID string) error {
	if !s.openerEnabled {
		return nil
	}
	var agentCount, humanCount int
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM agents WHERE workspace_id = ? AND deleted_at IS NULL`,
		workspaceID).Scan(&agentCount); err != nil {
		return fmt.Errorf("count agents: %w", err)
	}
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ?`,
		workspaceID).Scan(&humanCount); err != nil {
		return fmt.Errorf("count humans: %w", err)
	}
	if agentCount+humanCount < 3 {
		return nil
	}
	// The owner's unlock-instruction claim gates the flip (TS reads
	// serverMembers.allChannelUnlockInstructionSentAt): once the instruction
	// went out the reveal already happened for that owner.
	var ownerID string
	var unlockSent sql.NullInt64
	err := q.QueryRowContext(ctx, `
		SELECT w.owner_id, s.all_channel_unlock_instruction_sent_at
		FROM workspaces w
		LEFT JOIN workspace_member_setup s
		       ON s.workspace_id = w.id AND s.user_id = w.owner_id
		WHERE w.id = ?`, workspaceID).Scan(&ownerID, &unlockSent)
	if err != nil {
		return fmt.Errorf("read owner unlock claim: %w", err)
	}
	if unlockSent.Valid {
		return nil
	}
	if _, err := q.ExecContext(ctx, `
		UPDATE channels SET type = 'channel'
		WHERE workspace_id = ? AND name = 'all' AND type = 'private' AND deleted_at IS NULL`,
		workspaceID); err != nil {
		return fmt.Errorf("reveal all channel: %w", err)
	}
	return nil
}

// markOwnerSetupComplete ports markServerSetupCompleteOnFirstAgent: the
// OWNER's setup row goes complete/normal unless it already was.
func (s *Store) markOwnerSetupComplete(ctx context.Context, q executor, workspaceID string, now int64) error {
	var ownerID string
	err := q.QueryRowContext(ctx,
		`SELECT owner_id FROM workspaces WHERE id = ?`, workspaceID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read owner: %w", err)
	}
	res, err := q.ExecContext(ctx, `
		UPDATE workspace_member_setup
		SET status = 'complete', completion_reason = 'normal'
		WHERE workspace_id = ? AND user_id = ? AND status != 'complete'`,
		workspaceID, ownerID)
	if err != nil {
		return fmt.Errorf("mark owner setup complete: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		// No row yet (M1 member or fresh owner): insert the terminal fact
		// under the current contract version, like the TS upsert path.
		if _, err := q.ExecContext(ctx, `
			INSERT INTO workspace_member_setup (workspace_id, user_id, status, completion_reason, contract_version)
			SELECT ?, ?, 'complete', 'normal', 'onboarding-setup-v2'
			WHERE NOT EXISTS (SELECT 1 FROM workspace_member_setup WHERE workspace_id = ? AND user_id = ?)`,
			workspaceID, ownerID, workspaceID, ownerID); err != nil {
			return fmt.Errorf("insert owner setup complete: %w", err)
		}
	}
	return nil
}

func equalOptional(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sqlNullString(v *string) sql.NullString {
	if v == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *v, Valid: true}
}

// jsonString renders canonical JSON (nil stays SQL NULL).
func jsonString(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return string(raw)
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

// AgentPatch is a partial update; nil fields keep their current value.
type AgentPatch struct {
	DisplayName     *sql.NullString
	Description     *sql.NullString
	AvatarURL       *sql.NullString
	Model           *string
	Runtime         *string
	RuntimeConfig   *json.RawMessage
	ReasoningEffort *sql.NullString
	EnvVars         *json.RawMessage
}

// UpdateAgent applies a partial update and bumps updated_at.
func (s *Store) UpdateAgent(ctx context.Context, workspaceID, agentID string, patch AgentPatch) (*Agent, error) {
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		current, err := scanAgent(tx.QueryRowContext(ctx,
			`SELECT `+agentColumns+` FROM agents a WHERE a.id = ? AND a.workspace_id = ? AND a.deleted_at IS NULL`,
			agentID, workspaceID))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrAgentNotFound
		}
		if err != nil {
			return fmt.Errorf("read agent for update: %w", err)
		}

		set := []string{"updated_at = ?"}
		args := []any{s.now()}
		apply := func(column string, value any) {
			set = append(set, column+" = ?")
			args = append(args, value)
		}
		if patch.DisplayName != nil {
			apply("display_name", *patch.DisplayName)
		}
		if patch.Description != nil {
			apply("description", *patch.Description)
		}
		if patch.AvatarURL != nil {
			apply("avatar_url", *patch.AvatarURL)
		}
		if patch.Model != nil {
			apply("model", *patch.Model)
		}
		runtimeChanged := false
		if patch.Runtime != nil && *patch.Runtime != current.Runtime {
			runtimeChanged = true
			apply("runtime", *patch.Runtime)
		}
		if patch.RuntimeConfig != nil {
			apply("runtime_config", jsonString(*patch.RuntimeConfig))
		}
		if patch.ReasoningEffort != nil {
			apply("reasoning_effort", *patch.ReasoningEffort)
		}
		if patch.EnvVars != nil {
			apply("env_vars", jsonString(*patch.EnvVars))
		}
		// A runtime identity change invalidates the live session (TS writes
		// sessionId=null whenever runtimeChanged).
		if runtimeChanged {
			apply("session_id", nil)
		}
		args = append(args, agentID)
		if _, err := tx.ExecContext(ctx,
			`UPDATE agents SET `+strings.Join(set, ", ")+` WHERE id = ?`, args...); err != nil {
			return fmt.Errorf("update agent: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetAgent(ctx, agentID, false)
}

// UpdateAgentStatus ports updateAgentStatus. The DB-layer guard is exactly
// the TS one: an `inactive` write never overwrites a manual `stopped` — only
// an explicit active write (start / reset restart) resurrects a stopped
// agent. statusChangedAt moves only on a real change.
func (s *Store) UpdateAgentStatus(ctx context.Context, agentID, next string, sessionID *sql.NullString) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var current string
		err := tx.QueryRowContext(ctx,
			`SELECT status FROM agents WHERE id = ? AND deleted_at IS NULL`, agentID).Scan(&current)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrAgentNotFound
		}
		if err != nil {
			return fmt.Errorf("read agent status: %w", err)
		}
		if next == StatusInactive && current == StatusStopped {
			return nil // inactive never overwrites manual-stopped
		}
		if current == next && sessionID == nil {
			return nil
		}
		set := "status = ?"
		args := []any{next}
		if current != next {
			set += ", status_changed_at = ?"
			args = append(args, s.now())
		}
		if sessionID != nil {
			set += ", session_id = ?"
			args = append(args, *sessionID)
		}
		set += ", updated_at = ?"
		args = append(args, s.now())
		args = append(args, agentID)
		if _, err := tx.ExecContext(ctx, `UPDATE agents SET `+set+` WHERE id = ?`, args...); err != nil {
			return fmt.Errorf("update agent status: %w", err)
		}
		return nil
	})
}

// ResetAgentSession ports resetAgentSession: clear the session pointer and
// settle status (a manual-stopped agent stays stopped).
func (s *Store) ResetAgentSession(ctx context.Context, agentID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var current string
		err := tx.QueryRowContext(ctx,
			`SELECT status FROM agents WHERE id = ? AND deleted_at IS NULL`, agentID).Scan(&current)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrAgentNotFound
		}
		if err != nil {
			return fmt.Errorf("read agent for session reset: %w", err)
		}
		next := StatusInactive
		if current == StatusStopped {
			next = StatusStopped
		}
		now := s.now()
		set := "session_id = NULL, updated_at = ?"
		args := []any{now}
		if current != next {
			set += ", status = ?, status_changed_at = ?"
			args = append(args, next, now)
		}
		args = append(args, agentID)
		if _, err := tx.ExecContext(ctx,
			`UPDATE agents SET `+set+` WHERE id = ?`, args...); err != nil {
			return fmt.Errorf("reset agent session: %w", err)
		}
		return nil
	})
}

// AssignMachine binds (nil unbinds) the machine. The machine must belong to
// the workspace; the caller validates.
func (s *Store) AssignMachine(ctx context.Context, workspaceID, agentID string, machineID *string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE agents SET machine_id = ?, updated_at = ?
		WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		machineID, s.now(), agentID, workspaceID)
	if err != nil {
		return fmt.Errorf("assign machine: %w", err)
	}
	return nil
}

// UpdateAgentMemberRole ports updateAgentMemberRole (admin/member).
func (s *Store) UpdateAgentMemberRole(ctx context.Context, workspaceID, agentID, role string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE agent_members SET role = ?, updated_at = ?
		WHERE workspace_id = ? AND agent_id = ?`, role, s.now(), workspaceID, agentID)
	if err != nil {
		return fmt.Errorf("update agent member role: %w", err)
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return errf(404, "", "Agent server membership not found")
	}
	return nil
}

// AdoptOnboardingIdentity ports adoptOfficialOnboardingAgentIdentity: force
// the official name/display/description/avatar and the admin server role.
// Name conflicts surface as the legacy 409 body.
func (s *Store) AdoptOnboardingIdentity(ctx context.Context, workspaceID, agentID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var currentName string
		err := tx.QueryRowContext(ctx,
			`SELECT name FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
			agentID, workspaceID).Scan(&currentName)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrAgentNotFound
		}
		if err != nil {
			return fmt.Errorf("read agent for adoption: %w", err)
		}
		if currentName != OfficialAgentName {
			if err := s.assertHandleAvailable(ctx, tx, workspaceID, OfficialAgentName); err != nil {
				return err
			}
		}
		now := s.now()
		if _, err := tx.ExecContext(ctx, `
			UPDATE agents SET name = ?, display_name = ?, description = ?, avatar_url = ?, updated_at = ?
			WHERE id = ?`, OfficialAgentName, OfficialAgentDisplayName,
			OfficialAgentDescription, OfficialAgentAvatarURL, now, agentID); err != nil {
			if db.IsUniqueViolation(err, "idx_agents_workspace_name") {
				return errf(409, "", "Agent name is already taken")
			}
			return fmt.Errorf("adopt identity: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE agent_members SET role = ?, updated_at = ?
			WHERE workspace_id = ? AND agent_id = ?`,
			OfficialAgentServerRole, now, workspaceID, agentID); err != nil {
			return fmt.Errorf("adopt role: %w", err)
		}
		return nil
	})
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

// DeleteAgent soft-deletes the agent and, in the same transaction, performs
// the identity-side teardown: membership removal, credential revocation
// (rows never deleted), and the durable purge intent when a machine holds
// the agent's local state. onboarding pointer and setup facts survive —
// deletion never revives setup or reset (terminal checkpoint).
func (s *Store) DeleteAgent(ctx context.Context, workspaceID, agentID string) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		var machineID sql.NullString
		err := tx.QueryRowContext(ctx, `
			SELECT machine_id FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
			agentID, workspaceID).Scan(&machineID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrAgentNotFound
		}
		if err != nil {
			return fmt.Errorf("read agent for delete: %w", err)
		}
		now := s.now()
		if _, err := tx.ExecContext(ctx, `
			UPDATE agents SET deleted_at = ?, status = 'inactive', status_changed_at = ?,
				session_id = NULL, machine_id = NULL, updated_at = ?
			WHERE id = ?`, now, now, now, agentID); err != nil {
			return fmt.Errorf("soft delete agent: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM agent_members WHERE workspace_id = ? AND agent_id = ?`,
			workspaceID, agentID); err != nil {
			return fmt.Errorf("delete agent membership: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE agent_credentials SET revoked_at = ?, revoked_reason = 'agent_deleted'
			WHERE agent_id = ? AND revoked_at IS NULL`, now, agentID); err != nil {
			return fmt.Errorf("revoke agent credentials: %w", err)
		}
		if machineID.Valid {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO machine_pending_agent_purges (machine_id, agent_id, created_at)
				VALUES (?, ?, ?)
				ON CONFLICT(machine_id, agent_id) DO NOTHING`,
				machineID.String, agentID, now); err != nil {
				return fmt.Errorf("record pending purge: %w", err)
			}
		}
		return nil
	})
}

// OwnerSetupStatus is the exported read the create handler snapshots for
// the create-vs-reset CAS.
func (s *Store) OwnerSetupStatus(ctx context.Context, workspaceID string) (*string, error) {
	return s.ownerSetupStatus(ctx, s.db, workspaceID)
}

// ActiveAgentNamedCindy is the exported case-insensitive duplicate guard.
func (s *Store) ActiveAgentNamedCindy(ctx context.Context, workspaceID string) (bool, error) {
	return s.activeAgentNamedCindy(ctx, s.db, workspaceID)
}
