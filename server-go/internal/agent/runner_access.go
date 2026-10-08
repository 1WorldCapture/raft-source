// Computer-hosted runner credential mint and revoke.
//
// The original daemon (packages/daemon/src/core.ts and agentProcessManager.ts)
// calls POST/DELETE /internal/computer/runners/:agentId/credentials around
// every managed launch. Those rows live in the 0008 agent_credentials table
// and use the same CredentialHasher as Store. This type is separate from
// Store so the main Agent worker keeps ownership of Store, Service and the
// start/stop lifecycle.
//
// Argon2id runs before the write transaction. The transaction then re-reads
// the computer (or legacy machine) and the agent: a revocation or machine
// reassignment that landed while hashing rolls the insert back.
// Runner credentials have no expiry column; revocation is the only terminal
// state. The raw sk_agent_* key is returned once and is never stored.
package agent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
)

// Runner capability vocabulary (TS ALLOWED_AGENT_CAPABILITIES), in the order
// the mint error string lists them. Stored and returned scopes are this set
// deduplicated and sorted.
var runnerCapabilities = []string{
	"send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "mcp",
}

const runnerScopesInvalidMessage = "scopes must each be one of: send, read, mentions, tasks, reactions, server, channels, knowledge, mcp"

// Managed-runner revoke reason (TS DELETE credentials handler).
const RunnerRevokeReason = "managed_runner_launch_ended"

// Runner list projection (TS RUNNER_LIST_WHITELIST). The query selects these
// columns only; session_id, env_vars and other agent fields are not loaded.
var RunnerListFields = []string{"agentId", "name", "status", "model", "runtime"}

// Wire errors for the computer runner surface. Pointer identity matters:
// callers compare with AsError.
var (
	ErrRunnerAgentMissing      = errf(404, "agent_missing", "Agent not found")
	ErrRunnerCredentialMissing = errf(404, "credential_missing", "Credential not found")
	ErrRunnerComputerDenied    = errf(401, "", "Invalid computer credential")
	ErrRunnerLegacyMigrated    = errf(401, "legacy_machine_key_migrated", "Legacy machine key has been migrated to a Computer attachment")
	ErrRunnerServerGone        = errf(401, "", "Server no longer exists")
	ErrRunnerAuthState         = errf(500, "", "Computer authentication state missing")
	ErrRunnerComputerBinding   = errf(500, "computer_binding_missing", "Computer authentication state missing")
	ErrRunnerMachineBinding    = errf(500, "machine_binding_missing", "Computer machine binding missing")
	ErrRunnerScopesType        = errf(400, "scopes_invalid", "scopes must be an array of capability literals")
	ErrRunnerScopesValue       = errf(400, "scopes_invalid", runnerScopesInvalidMessage)
	ErrRunnerScopesEmpty       = errf(400, "scopes_empty", "scopes must include at least one capability")
	ErrRunnerNameInvalid       = errf(400, "name_invalid", "name must be a non-empty string up to 200 chars")
	ErrRunnerInvalidScope      = errf(400, "invalid_scope", "Invalid runners scope")
)

// RunnerBinding is the computer the request authenticated as, plus the
// machine and workspace that authentication proved. LegacyMachine is the
// sk_machine_* phase-1 alias (there is no computers row; MachineID is the
// principal). ComputerID is the computers.id for a sk_computer_* key.
type RunnerBinding struct {
	// Principal is the original authenticated identity, including the
	// verifier revision. Keep legacy transport aliases out of this proof.
	Principal     computer.Principal
	ComputerID    string
	MachineID     string
	WorkspaceID   string
	LegacyMachine bool
}

// RunnerAccessOptions injects the clock and the process credential hasher.
// Hasher must be the same CredentialHasher the Agent Store uses.
type RunnerAccessOptions struct {
	Clock  clock.Clock
	Hasher *CredentialHasher
}

// RunnerAccess mints, lists and revokes runner credentials for one computer.
type RunnerAccess struct {
	db     *sql.DB
	clock  clock.Clock
	hasher *CredentialHasher

	// beforeGuard runs inside the open transaction before the binding
	// re-read. beforeCommit runs after the write statement and before
	// commit. Both stay nil in production; tests set them to prove a
	// revocation or reassignment rolls the write back.
	beforeGuard  func(context.Context, *sql.Tx) error
	beforeCommit func(context.Context, *sql.Tx) error
}

// NewRunnerAccess builds the writer. The database must already include
// migration 0008. A nil hasher is refused: this path cannot store a
// plaintext key.
func NewRunnerAccess(handle *sql.DB, opts RunnerAccessOptions) (*RunnerAccess, error) {
	if handle == nil {
		return nil, errors.New("runner access: nil database")
	}
	if opts.Hasher == nil {
		return nil, errors.New("runner access: credential hasher is required")
	}
	clk := opts.Clock
	if clk == nil {
		clk = clock.Real{}
	}
	return &RunnerAccess{db: handle, clock: clk, hasher: opts.Hasher}, nil
}

func (a *RunnerAccess) now() int64 { return a.clock.Now().UnixMilli() }

// RunnerLifecycle is the manual-stop seam owned by the main Agent service.
// *Service satisfies it. The computer route does not dispatch agent:stop or
// write agent status itself.
type RunnerLifecycle interface {
	Stop(ctx context.Context, a *Agent) error
}

// MintedRunnerCredential is the one-time mint result. APIKey is the raw
// sk_agent_* secret; only its hash and prefix are persisted.
type MintedRunnerCredential struct {
	CredentialID string
	APIKey       string
	Scopes       []string
	AgentID      string
	AgentName    string
	WorkspaceID  string
}

// RunnerSummary is one whitelist row. JSON names match the TS list.
type RunnerSummary struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
	Status  string `json:"status"`
	Model   string `json:"model"`
	Runtime string `json:"runtime"`
}

// NormalizeRunnerScopes applies the TS mint rules. A nil slice means "all
// capabilities" (the omitted-field default). An empty slice is scopes_empty.
// Any value outside the v0 enum is scopes_invalid. The result is deduped
// and sorted, which is what mintAgentCredential persists.
func NormalizeRunnerScopes(scopes []string) ([]string, error) {
	if scopes == nil {
		scopes = append([]string(nil), runnerCapabilities...)
	}
	if len(scopes) == 0 {
		return nil, ErrRunnerScopesEmpty
	}
	seen := make(map[string]struct{}, len(scopes))
	out := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if !runnerCapabilityAllowed(scope) {
			return nil, ErrRunnerScopesValue
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		out = append(out, scope)
	}
	if len(out) == 0 {
		return nil, ErrRunnerScopesEmpty
	}
	sort.Strings(out)
	return out, nil
}

func runnerCapabilityAllowed(scope string) bool {
	for _, allowed := range runnerCapabilities {
		if scope == allowed {
			return true
		}
	}
	return false
}

// ValidateRunnerName applies the TS name rule. nil is the omitted/null
// default. Match JavaScript string.length: 1..200 UTF-16 code units.
func ValidateRunnerName(name *string) error {
	if name == nil {
		return nil
	}
	n := 0
	for _, r := range *name {
		n++
		if r > 0xffff {
			n++
		}
		if n > 200 {
			return ErrRunnerNameInvalid
		}
	}
	if n == 0 {
		return ErrRunnerNameInvalid
	}
	return nil
}

// Mint writes one new agent_credentials row bound to the agent the computer
// currently hosts. Existing credentials are not revoked. The raw key is
// hashed before the write transaction; the transaction re-checks the live
// computer/machine/workspace binding and rolls back if it moved.
func (a *RunnerAccess) Mint(ctx context.Context, binding RunnerBinding, agentID string, scopes []string, name *string) (*MintedRunnerCredential, error) {
	normalized, err := NormalizeRunnerScopes(scopes)
	if err != nil {
		return nil, err
	}
	if err := ValidateRunnerName(name); err != nil {
		return nil, err
	}
	// Fast refusal before argon2. The write transaction below is the
	// authority: a binding change during hashing still cannot commit.
	if err := a.inTx(ctx, func(tx *sql.Tx) error {
		machineID, workspaceID, err := a.resolve(ctx, tx, binding, true, false)
		if err != nil {
			return err
		}
		_, err = a.agentOn(ctx, tx, agentID, machineID, workspaceID)
		return err
	}); err != nil {
		return nil, err
	}

	apiKey, apiKeyHash, prefix, err := a.hasher.newAPIKeyMaterial()
	if err != nil {
		return nil, err
	}
	scopesJSON, err := encodeScopes(normalized)
	if err != nil {
		return nil, err
	}
	id := auth.NewUUID()
	var agentName, workspaceID string
	err = a.inTx(ctx, func(tx *sql.Tx) error {
		machineID, ws, err := a.resolve(ctx, tx, binding, true, true)
		if err != nil {
			return err
		}
		row, err := a.agentOn(ctx, tx, agentID, machineID, ws)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO agent_credentials (
				id, agent_id, api_key_hash, api_key_prefix, name, scopes, created_by_user_id, created_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
			id, agentID, apiKeyHash, prefix, name, scopesJSON, a.now()); err != nil {
			return fmt.Errorf("insert runner credential: %w", err)
		}
		if a.beforeCommit != nil {
			if err := a.beforeCommit(ctx, tx); err != nil {
				return err
			}
		}
		agentName = row.Name
		workspaceID = ws
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &MintedRunnerCredential{
		CredentialID: id,
		APIKey:       apiKey,
		Scopes:       normalized,
		AgentID:      agentID,
		AgentName:    agentName,
		WorkspaceID:  workspaceID,
	}, nil
}

// Revoke soft-revokes one credential when the agent is still on this
// computer's current machine in the same workspace. Already-revoked rows
// stay revoked and return nil (HTTP 204). A binding change inside the
// transaction aborts the update.
func (a *RunnerAccess) Revoke(ctx context.Context, binding RunnerBinding, agentID, credentialID string) error {
	return a.inTx(ctx, func(tx *sql.Tx) error {
		machineID, workspaceID, err := a.resolve(ctx, tx, binding, true, true)
		if err != nil {
			return err
		}
		if _, err := a.agentOn(ctx, tx, agentID, machineID, workspaceID); err != nil {
			return err
		}
		var owner string
		var revoked sql.NullInt64
		err = tx.QueryRowContext(ctx, `
			SELECT agent_id, revoked_at FROM agent_credentials WHERE id = ?`, credentialID).
			Scan(&owner, &revoked)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrRunnerCredentialMissing
		}
		if err != nil {
			return fmt.Errorf("read runner credential: %w", err)
		}
		if owner != agentID {
			return ErrRunnerCredentialMissing
		}
		if revoked.Valid {
			return nil
		}
		res, err := tx.ExecContext(ctx, `
			UPDATE agent_credentials
			SET revoked_at = ?, revoked_reason = ?, revoked_by_user_id = NULL
			WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
			a.now(), RunnerRevokeReason, credentialID, agentID)
		if err != nil {
			return fmt.Errorf("revoke runner credential: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrRunnerCredentialMissing
		}
		if a.beforeCommit != nil {
			return a.beforeCommit(ctx, tx)
		}
		return nil
	})
}

// List returns the whitelist projection. scope "" and "machine" are the
// current machine; "server" is every live agent in the computer's workspace.
func (a *RunnerAccess) List(ctx context.Context, binding RunnerBinding, scope string) ([]RunnerSummary, error) {
	serverWide := false
	switch scope {
	case "", "machine":
	case "server":
		serverWide = true
	default:
		return nil, ErrRunnerInvalidScope
	}
	var out []RunnerSummary
	err := a.inTx(ctx, func(tx *sql.Tx) error {
		machineID, workspaceID, err := a.resolve(ctx, tx, binding, !serverWide, true)
		if err != nil {
			return err
		}
		wide := 0
		if serverWide {
			wide = 1
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT a.id, a.name, a.status, a.model, a.runtime
			FROM agents a
			WHERE a.workspace_id = ? AND a.deleted_at IS NULL
			  AND (? = 1 OR a.machine_id = ?)`,
			workspaceID, wide, machineID)
		if err != nil {
			return fmt.Errorf("list runners: %w", err)
		}
		defer rows.Close()
		out = []RunnerSummary{}
		for rows.Next() {
			var row RunnerSummary
			if err := rows.Scan(&row.AgentID, &row.Name, &row.Status, &row.Model, &row.Runtime); err != nil {
				return fmt.Errorf("scan runner: %w", err)
			}
			out = append(out, row)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []RunnerSummary{}
	}
	return out, nil
}

// ConfirmRunner re-reads the live binding and returns the agent when it is
// still on this computer's current machine. The caller then uses
// RunnerLifecycle; this method does not stop anything.
func (a *RunnerAccess) ConfirmRunner(ctx context.Context, binding RunnerBinding, agentID string) (*Agent, error) {
	var row *Agent
	err := a.inTx(ctx, func(tx *sql.Tx) error {
		machineID, workspaceID, err := a.resolve(ctx, tx, binding, true, true)
		if err != nil {
			return err
		}
		row, err = a.agentOn(ctx, tx, agentID, machineID, workspaceID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return row, nil
}

// Authorize re-reads the computer or legacy machine. Provider-connection
// uses it so a revoked computer is denied before the C0 refusal, without
// loading any provider secret (this server has no provider-connection store).
func (a *RunnerAccess) Authorize(ctx context.Context, binding RunnerBinding, needMachine bool) error {
	return a.inTx(ctx, func(tx *sql.Tx) error {
		_, _, err := a.resolve(ctx, tx, binding, needMachine, true)
		return err
	})
}

// resolve re-reads the principal's current machine and workspace. hook runs
// beforeGuard first when true, so a test mutation is visible to this read.
func (a *RunnerAccess) resolve(ctx context.Context, tx *sql.Tx, binding RunnerBinding, needMachine, hook bool) (machineID, workspaceID string, err error) {
	if hook && a.beforeGuard != nil {
		if err := a.beforeGuard(ctx, tx); err != nil {
			return "", "", err
		}
	}
	if binding.WorkspaceID == "" {
		return "", "", ErrRunnerAuthState
	}
	// The middleware proof must survive every later transaction, including
	// the second mint transaction after hashing. Re-reading only IDs would
	// accept a rotated key and let the old caller mint new Agent credentials.
	p := binding.Principal
	if p.WorkspaceID != binding.WorkspaceID || p.MachineID != binding.MachineID ||
		(binding.LegacyMachine && p.Kind != computer.KindLegacyMachine) ||
		(!binding.LegacyMachine && (p.Kind != computer.KindComputer || p.ComputerID != binding.ComputerID)) {
		return "", "", ErrRunnerComputerDenied
	}
	if err := computer.ValidatePrincipalTx(ctx, tx, p); err != nil {
		if denied := computer.AsAuthError(err); denied != nil {
			switch denied.Reason {
			case computer.ReasonLegacyKeyMigrated:
				return "", "", ErrRunnerLegacyMigrated
			case computer.ReasonServerNotFound:
				return "", "", ErrRunnerServerGone
			default:
				return "", "", ErrRunnerComputerDenied
			}
		}
		return "", "", err
	}
	if binding.LegacyMachine {
		if binding.MachineID == "" {
			return "", "", ErrRunnerMachineBinding
		}
		var ws string
		var migrated sql.NullInt64
		err := tx.QueryRowContext(ctx, `
			SELECT workspace_id, legacy_key_migrated_at FROM machines WHERE id = ?`,
			binding.MachineID).Scan(&ws, &migrated)
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", ErrRunnerComputerDenied
		}
		if err != nil {
			return "", "", fmt.Errorf("read legacy machine: %w", err)
		}
		if migrated.Valid {
			return "", "", ErrRunnerLegacyMigrated
		}
		if ws != binding.WorkspaceID {
			return "", "", ErrRunnerComputerDenied
		}
		if err := a.workspaceLive(ctx, tx, ws); err != nil {
			return "", "", err
		}
		return binding.MachineID, ws, nil
	}
	if binding.ComputerID == "" {
		return "", "", ErrRunnerComputerBinding
	}
	var machine sql.NullString
	var ws string
	var revoked sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT machine_id, workspace_id, revoked_at FROM computers WHERE id = ?`,
		binding.ComputerID).Scan(&machine, &ws, &revoked)
	if errors.Is(err, sql.ErrNoRows) || revoked.Valid {
		return "", "", ErrRunnerComputerDenied
	}
	if err != nil {
		return "", "", fmt.Errorf("read computer binding: %w", err)
	}
	if ws != binding.WorkspaceID {
		return "", "", ErrRunnerComputerDenied
	}
	if err := a.workspaceLive(ctx, tx, ws); err != nil {
		return "", "", err
	}
	if !machine.Valid || machine.String == "" {
		if needMachine {
			return "", "", ErrRunnerMachineBinding
		}
		return "", ws, nil
	}
	var machineWorkspace string
	err = tx.QueryRowContext(ctx, `SELECT workspace_id FROM machines WHERE id = ?`, machine.String).Scan(&machineWorkspace)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && machineWorkspace != ws) {
		if needMachine {
			return "", "", ErrRunnerMachineBinding
		}
		return "", ws, nil
	}
	if err != nil {
		return "", "", fmt.Errorf("read computer machine: %w", err)
	}
	return machine.String, ws, nil
}

func (a *RunnerAccess) workspaceLive(ctx context.Context, tx *sql.Tx, workspaceID string) error {
	var deleted sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT deleted_at FROM workspaces WHERE id = ?`, workspaceID).Scan(&deleted)
	if errors.Is(err, sql.ErrNoRows) || deleted.Valid {
		return ErrRunnerServerGone
	}
	if err != nil {
		return fmt.Errorf("read workspace: %w", err)
	}
	return nil
}

// agentOn loads only the identity fields mint and stop need. session_id,
// env_vars and runtime_config are not selected: they are not part of this
// decision, and json.RawMessage cannot scan SQL NULL.
func (a *RunnerAccess) agentOn(ctx context.Context, tx *sql.Tx, agentID, machineID, workspaceID string) (*Agent, error) {
	var row Agent
	err := tx.QueryRowContext(ctx, `
		SELECT a.id, a.workspace_id, a.name, a.status, a.runtime, a.machine_id
		FROM agents a
		WHERE a.id = ? AND a.deleted_at IS NULL`, agentID).Scan(
		&row.ID, &row.WorkspaceID, &row.Name, &row.Status, &row.Runtime, &row.MachineID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRunnerAgentMissing
	}
	if err != nil {
		return nil, fmt.Errorf("read runner agent: %w", err)
	}
	if row.WorkspaceID != workspaceID || !row.MachineID.Valid || row.MachineID.String != machineID {
		return nil, ErrRunnerAgentMissing
	}
	return &row, nil
}

func (a *RunnerAccess) inTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin runner access tx: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit runner access tx: %w", err)
	}
	committed = true
	return nil
}
