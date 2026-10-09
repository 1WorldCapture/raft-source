// Persistent agent launch / start-dispatch facts (M5 §5.4). The in-memory
// fence in launch_fence.go survives unchanged for the M3 manual start path;
// this store is the durable, restart-surviving projection of "which launch
// did the server dispatch, on which machine, with which dispatch id, and
// what queue state did the daemon report". agent_launches is created by
// 0014_delivery.sql and gains a nullable confirmed_session_id in
// 0015_launch_session.sql. That column is the dispatch session for THIS
// launch only. agents.session_id remains the resume pointer sent on
// agent:start and is never copied into the launch. Until both migrations
// are applied, NewLaunchStore refuses so the M5 paths fail closed.
package agent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
)

// Launch states (0014 CHECK constraint, verbatim). reserved: reserved in a
// short transaction, agent:start not yet queued (or the send failed and
// recovery owes a resend). dispatched: at least one agent:start queued for
// this dispatch id (dispatch_count counts sends). acked: the daemon answered
// agent:start:ack — a REPORTED queue state, never a session. superseded /
// cancelled / failed are terminal; late frames for them change nothing.
const (
	LaunchStateReserved   = "reserved"
	LaunchStateDispatched = "dispatched"
	LaunchStateAcked      = "acked"
	LaunchStateSuperseded = "superseded"
	LaunchStateFailed     = "failed"
	LaunchStateCancelled  = "cancelled"
)

// launchOpenStates still owe resolution (the recovery window).
var launchOpenStates = []string{LaunchStateReserved, LaunchStateDispatched}

// launchCurrentStates are the states that make a launch the agent's current
// identity fence (acked stays current: the session may land after the ack).
var launchCurrentStates = []string{LaunchStateReserved, LaunchStateDispatched, LaunchStateAcked}

// launchAckStates is the agent:start:ack queueState closed set (0014 CHECK).
var launchAckStates = map[string]bool{
	"queued": true, "starting": true, "running": true, "rebound": true,
}

// Launch is one persisted agent_launches row.
type Launch struct {
	ID              string // launchId (the fence value the daemon echoes)
	StartDispatchID string
	WorkspaceID     string
	AgentID         string
	MachineID       string
	State           string
	QueueState      sql.NullString // daemon-REPORTED queue state (never a session)
	DispatchCount   int64
	LastDispatchAt  sql.NullInt64
	AckedAt         sql.NullInt64
	TerminalCode    sql.NullString
	Revision        int64
	CreatedAt       int64
	UpdatedAt       int64
	// ConfirmedSessionID is the session the authenticated daemon reported
	// for THIS launch. Null until that agent:session transaction commits.
	// It is not agents.session_id and it is never backfilled.
	ConfirmedSessionID sql.NullString
}

// LaunchStore reads and writes agent_launches. It owns no goroutines and no
// network; every standalone method is one short transaction, and the Tx
// methods run inside the caller's transaction.
type LaunchStore struct {
	db    *sql.DB
	clock clock.Clock
}

// NewLaunchStore verifies the agent_launches table exists (0014 applied) and
// returns the store. A missing table is a construction failure: the parent
// must not wire M5 delivery lifecycle paths against a database that cannot
// persist launch fencing.
func NewLaunchStore(handle *sql.DB, clockSource clock.Clock) (*LaunchStore, error) {
	if handle == nil {
		return nil, errors.New("agent launch store: nil database")
	}
	var name string
	err := handle.QueryRowContext(context.Background(),
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_launches'`).
		Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("agent launch store: agent_launches table is missing (requires migration 0014)")
	}
	if err != nil {
		return nil, fmt.Errorf("agent launch store: verify schema: %w", err)
	}
	err = handle.QueryRowContext(context.Background(),
		`SELECT name FROM pragma_table_info('agent_launches') WHERE name = 'confirmed_session_id'`).
		Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("agent launch store: agent_launches.confirmed_session_id is missing (requires migration 0015)")
	}
	if err != nil {
		return nil, fmt.Errorf("agent launch store: verify confirmed session column: %w", err)
	}
	clk := clockSource
	if clk == nil {
		clk = clock.Real{}
	}
	return &LaunchStore{db: handle, clock: clk}, nil
}

func (l *LaunchStore) now() int64 { return l.clock.Now().UnixMilli() }

func (l *LaunchStore) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return db.WithWriteTx(ctx, l.db, fn)
}

const launchColumns = `id, start_dispatch_id, workspace_id, agent_id, machine_id,
	state, queue_state, dispatch_count, last_dispatch_at, acked_at, terminal_code,
	revision, created_at, updated_at, confirmed_session_id`

func qualifiedLaunchColumns(alias string) string {
	cols := strings.Split(launchColumns, ",")
	for i, col := range cols {
		cols[i] = alias + "." + strings.TrimSpace(col)
	}
	return strings.Join(cols, ", ")
}

func scanLaunchRow(row interface{ Scan(...any) error }) (*Launch, error) {
	var launch Launch
	err := row.Scan(&launch.ID, &launch.StartDispatchID, &launch.WorkspaceID, &launch.AgentID,
		&launch.MachineID, &launch.State, &launch.QueueState, &launch.DispatchCount,
		&launch.LastDispatchAt, &launch.AckedAt, &launch.TerminalCode,
		&launch.Revision, &launch.CreatedAt, &launch.UpdatedAt, &launch.ConfirmedSessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read agent launch: %w", err)
	}
	return &launch, nil
}

// currentLaunchOn is the dispatch identity: the newest open launch whose
// machine is the agent's current machine. A launch left on a previous
// machine is not current, even if it is the newest row. agents.session_id
// is not consulted.
func currentLaunchOn(ctx context.Context, q executor, workspaceID, agentID string) (*Launch, error) {
	return scanLaunchRow(q.QueryRowContext(ctx, `
		SELECT `+qualifiedLaunchColumns("l")+` FROM agent_launches AS l
		JOIN agents AS a ON a.id = l.agent_id AND a.workspace_id = l.workspace_id
		WHERE l.workspace_id = ? AND l.agent_id = ?
		  AND l.state IN ('reserved','dispatched','acked')
		  AND a.deleted_at IS NULL
		  AND a.machine_id = l.machine_id
		ORDER BY l.created_at DESC, l.id DESC LIMIT 1`, workspaceID, agentID))
}

// ReserveStartLaunchTx reserves (or reuses) the agent's start dispatch inside
// the caller's transaction. It NEVER trusts the caller's snapshot of the
// agent: the agent, workspace, status and machine binding are re-read under
// the SAME transaction and a deleted agent, deleted workspace, stopped
// agent, moved machine or workspace mismatch refuses before any row is
// written (the reservation cannot mint identity for facts that already
// changed). On success it returns the launch together with the FRESH agent
// row so the dispatch command is built from current config, not the
// caller's stale copy. Dedup rule (design §6.3): one unconfirmed start per
// agent — a second caller (a batch mention) gets the SAME launch /
// startDispatchId so the daemon sees one start, not N. A launch whose
// machine no longer matches (the agent moved machines) is superseded — its
// receipts cannot leak into the new launch — and a fresh launch is minted.
func (l *LaunchStore) ReserveStartLaunchTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, machineID string) (*Launch, *Agent, error) {
	return l.reserveStartLaunchTx(ctx, tx, workspaceID, agentID, machineID, false)
}

// ReserveStartLaunchRestartTx is the manual-Start form: a human's explicit
// start may restart a stopped agent (the M3 explicit-active-write rule), so
// the stopped guard is lifted. The delivery-driven path never uses this —
// schedulers must not force-wake a stopped agent (design §6.3).
func (l *LaunchStore) ReserveStartLaunchRestartTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, machineID string) (*Launch, *Agent, error) {
	return l.reserveStartLaunchTx(ctx, tx, workspaceID, agentID, machineID, true)
}

func (l *LaunchStore) reserveStartLaunchTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, machineID string, allowStopped bool) (*Launch, *Agent, error) {
	if workspaceID == "" || agentID == "" || machineID == "" {
		return nil, nil, errf(400, "", "launch reservation requires workspace, agent and machine")
	}
	// Live-fact re-read under the caller's transaction.
	var rowWorkspace string
	var rowStatus string
	var rowMachine sql.NullString
	var agentDeleted, workspaceDeleted sql.NullInt64
	err := tx.QueryRowContext(ctx, `
		SELECT a.workspace_id, a.status, a.machine_id, a.deleted_at, w.deleted_at
		FROM agents a LEFT JOIN workspaces w ON w.id = a.workspace_id
		WHERE a.id = ?`, agentID).
		Scan(&rowWorkspace, &rowStatus, &rowMachine, &agentDeleted, &workspaceDeleted)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && agentDeleted.Valid) {
		return nil, nil, ErrAgentMissing
	}
	if err != nil {
		return nil, nil, fmt.Errorf("reserve launch: read agent: %w", err)
	}
	if workspaceDeleted.Valid || rowWorkspace == "" {
		return nil, nil, errf(409, "server_gone", "Server no longer exists")
	}
	if rowWorkspace != workspaceID {
		return nil, nil, errf(409, "", "agent_server_mismatch")
	}
	if rowStatus == StatusStopped && !allowStopped {
		return nil, nil, errf(409, "agent_stopped", "Agent is stopped")
	}
	if !rowMachine.Valid || rowMachine.String != machineID {
		return nil, nil, errf(409, "machine_changed",
			"Agent is no longer bound to this machine")
	}
	fresh, err := scanAgent(tx.QueryRowContext(ctx,
		`SELECT `+agentColumns+` FROM agents a WHERE a.id = ?`, agentID))
	if err != nil {
		return nil, nil, fmt.Errorf("reserve launch: read agent projection: %w", err)
	}

	// A launch on any other machine is not this generation. Supersede all of
	// them before the same-machine dedupe, including rows currentLaunchOn
	// will no longer return.
	now := l.now()
	if _, err := tx.ExecContext(ctx, `
		UPDATE agent_launches
		SET state = ?, terminal_code = ?, revision = revision + 1, updated_at = ?
		WHERE workspace_id = ? AND agent_id = ?
		  AND state IN ('reserved','dispatched','acked')
		  AND machine_id != ?`,
		LaunchStateSuperseded, "machine_changed", now, workspaceID, agentID, machineID); err != nil {
		return nil, nil, fmt.Errorf("supersede stale launches: %w", err)
	}
	current, err := currentLaunchOn(ctx, tx, workspaceID, agentID)
	if err != nil {
		return nil, nil, err
	}
	if current != nil {
		return current, fresh, nil
	}
	launchID, err := newLaunchID()
	if err != nil {
		return nil, nil, fmt.Errorf("mint launch id: %w", err)
	}
	now = l.now()
	launch := &Launch{
		ID:              launchID,
		StartDispatchID: auth.NewUUID(),
		WorkspaceID:     workspaceID,
		AgentID:         agentID,
		MachineID:       machineID,
		State:           LaunchStateReserved,
		Revision:        1,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO agent_launches
			(id, start_dispatch_id, workspace_id, agent_id, machine_id, state,
			 revision, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		launch.ID, launch.StartDispatchID, launch.WorkspaceID, launch.AgentID,
		launch.MachineID, launch.State, launch.Revision,
		launch.CreatedAt, launch.UpdatedAt); err != nil {
		return nil, nil, fmt.Errorf("reserve agent launch: %w", err)
	}
	return launch, fresh, nil
}

// terminateTx moves an open launch to a terminal state with a short
// diagnostic code (terminal_code is free-form TEXT in 0014).
func (l *LaunchStore) terminateTx(ctx context.Context, tx *sql.Tx, launch *Launch, state, code string) error {
	now := l.now()
	_, err := tx.ExecContext(ctx, `
		UPDATE agent_launches
		SET state = ?, terminal_code = ?, revision = revision + 1, updated_at = ?
		WHERE id = ? AND state IN ('reserved','dispatched','acked')`,
		state, code, now, launch.ID)
	if err != nil {
		return fmt.Errorf("terminate agent launch: %w", err)
	}
	return nil
}

// TerminateAgentLaunchesTx ends every open launch of the agent except
// exceptLaunchID ("" terminates all) with the given terminal state/code.
// Stop/reset call this (cancelled/stopped) so a late daemon frame cannot
// extend a stopped agent's launch identity; machine moves use superseded.
// Returns the number of launches terminated.
func (l *LaunchStore) TerminateAgentLaunchesTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, exceptLaunchID, state, code string) (int64, error) {
	now := l.now()
	query := `
		UPDATE agent_launches
		SET state = ?, terminal_code = ?, revision = revision + 1, updated_at = ?
		WHERE workspace_id = ? AND agent_id = ?
		  AND state IN ('reserved','dispatched','acked')`
	args := []any{state, code, now, workspaceID, agentID}
	if exceptLaunchID != "" {
		query += ` AND id != ?`
		args = append(args, exceptLaunchID)
	}
	res, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("terminate agent launches: %w", err)
	}
	changed, _ := res.RowsAffected()
	return changed, nil
}

// TerminateAgentLaunches is the standalone form.
func (l *LaunchStore) TerminateAgentLaunches(ctx context.Context, workspaceID, agentID, exceptLaunchID, state, code string) (int64, error) {
	var changed int64
	err := l.withTx(ctx, func(tx *sql.Tx) error {
		var err error
		changed, err = l.TerminateAgentLaunchesTx(ctx, tx, workspaceID, agentID, exceptLaunchID, state, code)
		return err
	})
	return changed, err
}

// RecordStartDispatch records one agent:start send for the launch: the first
// send flips reserved -> dispatched; a RESEND of the same unconfirmed
// dispatch (offline recovery, wake retry) keeps state dispatched and bumps
// dispatch_count/last_dispatch_at so the daemon's dedup-by-dispatch-id is
// visible in the facts. A terminal launch is never resurrected (CAS).
func (l *LaunchStore) RecordStartDispatch(ctx context.Context, launchID string) error {
	return l.withTx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `
			UPDATE agent_launches
			SET state = 'dispatched', dispatch_count = dispatch_count + 1,
			    last_dispatch_at = ?, revision = revision + 1, updated_at = ?
			WHERE id = ? AND state IN ('reserved','dispatched')`,
			l.now(), l.now(), launchID)
		if err != nil {
			return fmt.Errorf("record start dispatch: %w", err)
		}
		if changed, _ := res.RowsAffected(); changed == 0 {
			return errf(409, "launch_not_dispatchable", "launch is terminal")
		}
		return nil
	})
}

// ApplyStartAckTx records one agent:start:ack. The frame is accepted only
// when it belongs to this machine's agent and names the CURRENT launch's
// startDispatchId; an echoed launchId, when present, must match too. The
// queueState is stored as the reported fact on queue_state. It NEVER
// establishes a session — running is the daemon's queue projection, not a
// runtime session (design §7.1) — and it never flips a terminal launch.
// Returns applied=false when the frame fences out.
func (l *LaunchStore) ApplyStartAckTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, machineID, startDispatchID, launchID, queueState string) (bool, error) {
	if !launchAckStates[queueState] {
		return false, nil
	}
	current, err := currentLaunchOn(ctx, tx, workspaceID, agentID)
	if err != nil || current == nil {
		return false, err
	}
	if current.MachineID != machineID || current.StartDispatchID != startDispatchID {
		return false, nil
	}
	if launchID != "" && launchID != current.ID {
		return false, nil
	}
	now := l.now()
	if current.State == LaunchStateAcked {
		// A repeated ack only refreshes the reported queue state; acked_at
		// keeps its first value.
		if current.QueueState.Valid && current.QueueState.String == queueState {
			return true, nil
		}
		_, err := tx.ExecContext(ctx, `
			UPDATE agent_launches SET queue_state = ?, revision = revision + 1, updated_at = ?
			WHERE id = ? AND state = 'acked'`, queueState, now, current.ID)
		return err == nil, err
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE agent_launches
		SET state = 'acked', queue_state = ?, acked_at = ?,
		    revision = revision + 1, updated_at = ?
		WHERE id = ? AND state IN ('reserved','dispatched')`,
		queueState, now, now, current.ID)
	if err != nil {
		return false, fmt.Errorf("apply start ack: %w", err)
	}
	changed, _ := res.RowsAffected()
	return changed > 0, nil
}

// AcceptSessionFrameTx is the durable fence for one agent:session report:
// the frame survives only when launchID is the agent's CURRENT launch on
// this machine (currentLaunchOn: same machine as the agent row). The
// caller writes the confirmed binding with ConfirmSessionTx in the SAME
// transaction. Returns accepted=false, nil when fenced out.
func (l *LaunchStore) AcceptSessionFrameTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, machineID, launchID string) (bool, error) {
	if launchID == "" {
		return false, nil
	}
	current, err := currentLaunchOn(ctx, tx, workspaceID, agentID)
	if err != nil || current == nil {
		return false, err
	}
	return current.ID == launchID && current.MachineID == machineID, nil
}

// ConfirmSessionTx binds sessionID to the current launch. It is the only
// writer of confirmed_session_id (ClearConfirmedSessionTx is the only
// clearer). The caller must already be inside the authenticated
// current-launch agent:session transaction. A blank session, a launch that
// is no longer current, or a machine mismatch writes nothing. The column
// is never backfilled from agents.session_id.
func (l *LaunchStore) ConfirmSessionTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, machineID, launchID, sessionID string) (bool, error) {
	sessionID = strings.TrimSpace(sessionID)
	if launchID == "" || sessionID == "" {
		return false, nil
	}
	current, err := currentLaunchOn(ctx, tx, workspaceID, agentID)
	if err != nil || current == nil {
		return false, err
	}
	if current.ID != launchID || current.MachineID != machineID {
		return false, nil
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE agent_launches
		SET confirmed_session_id = ?, revision = revision + 1, updated_at = ?
		WHERE id = ? AND workspace_id = ? AND agent_id = ? AND machine_id = ?
		  AND state IN ('reserved','dispatched','acked')`,
		sessionID, l.now(), launchID, workspaceID, agentID, machineID)
	if err != nil {
		return false, fmt.Errorf("confirm launch session: %w", err)
	}
	changed, _ := res.RowsAffected()
	return changed > 0, nil
}

// ClearConfirmedSessionTx drops the confirmed binding when the invalidated
// session is the one this current launch reported. A different session, or
// a launch that is no longer current, leaves the column untouched. The
// resume pointer on agents.session_id is the caller's decision.
func (l *LaunchStore) ClearConfirmedSessionTx(ctx context.Context, tx *sql.Tx, workspaceID, agentID, machineID, launchID, sessionID string) (bool, error) {
	sessionID = strings.TrimSpace(sessionID)
	if launchID == "" || sessionID == "" {
		return false, nil
	}
	current, err := currentLaunchOn(ctx, tx, workspaceID, agentID)
	if err != nil || current == nil {
		return false, err
	}
	if current.ID != launchID || current.MachineID != machineID {
		return false, nil
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE agent_launches
		SET confirmed_session_id = NULL, revision = revision + 1, updated_at = ?
		WHERE id = ? AND workspace_id = ? AND agent_id = ? AND machine_id = ?
		  AND confirmed_session_id = ?
		  AND state IN ('reserved','dispatched','acked')`,
		l.now(), launchID, workspaceID, agentID, machineID, sessionID)
	if err != nil {
		return false, fmt.Errorf("clear launch session: %w", err)
	}
	changed, _ := res.RowsAffected()
	return changed > 0, nil
}

// CurrentLaunch returns the agent's current same-machine launch (open or
// acked), or nil when the agent has none. Dispatch eligibility also
// requires ConfirmedSessionID; a launch alone is not a session.
func (l *LaunchStore) CurrentLaunch(ctx context.Context, workspaceID, agentID string) (*Launch, error) {
	return currentLaunchOn(ctx, l.db, workspaceID, agentID)
}

// ListUnconfirmedStartDispatches returns the machine's launches that still
// owe an agent:start (reserved: never queued or a failed send; dispatched:
// queued, no ack observed). Recovery re-sends the SAME launchId /
// startDispatchId — the daemon's start coordinator dedups by dispatch id, so
// a reconnect never triggers a parallel duplicate start.
func (l *LaunchStore) ListUnconfirmedStartDispatches(ctx context.Context, machineID string) ([]*Launch, error) {
	rows, err := l.db.QueryContext(ctx, `
		SELECT `+launchColumns+` FROM agent_launches
		WHERE machine_id = ? AND state IN ('reserved','dispatched')
		ORDER BY created_at ASC, id ASC`, machineID)
	if err != nil {
		return nil, fmt.Errorf("list unconfirmed start dispatches: %w", err)
	}
	defer rows.Close()
	var out []*Launch
	for rows.Next() {
		launch, err := scanLaunchRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, launch)
	}
	return out, rows.Err()
}
