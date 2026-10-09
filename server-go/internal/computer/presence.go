// Persistent machine presence facts (the REAL machines row, migration 0004).
// This file owns every SQL write/read for daemon ready/heartbeat/status
// observations; the machinews transport consumes it through the MachineFacts
// port and never touches a database handle itself.

package computer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

// Online continuity window (TS MACHINE_ONLINE_CONTINUITY_MS): a reconnect
// whose previous heartbeat is at most this old is treated as the same online
// stretch, so status_changed_at keeps its original value.
const onlineContinuity = 3 * time.Minute

// ComputerVersionRefreshInterval (TS COMPUTER_VERSION_REPORT_REFRESH_MS): an
// unchanged reported computer version is rewritten at most this often.
const ComputerVersionRefreshInterval = 24 * time.Hour

// ReadyFacts is one ready frame's persistable projection. nil pointers mean
// "absent from the frame" — the column keeps its previous value (TS
// `!== undefined` semantics). Runtimes is always written (the TS column write
// is unconditional; ready without a runtimes array is invalid).
type ReadyFacts struct {
	MachineID       string
	Runtimes        []string
	Hostname        *string
	OS              *string
	DaemonVersion   *string
	ComputerVersion string // "" = not reported this frame
	ObservedAt      time.Time
}

// StatusRecord mirrors machineService.MachineStatusRecord.
type StatusRecord struct {
	LastStatus      sql.NullString
	StatusChangedAt sql.NullInt64
}

// PresenceOptions carries constructor-time fault-injection hooks. Every
// field is test-only: production constructs with the zero value and the
// function VALUES are captured once at construction. There is deliberately
// no pointer-to-function form — a hook cannot be swapped on a live store,
// and tests that need to change behavior mid-scenario route their logic
// through their own mutable dispatcher captured by the closure.
type PresenceOptions struct {
	// TestFailReady, when it points at a positive counter, fails that many
	// ready writes after the principal recheck and before any column update.
	TestFailReady *atomic.Int32
	// TestBeforeReadyWrite runs after the caller was admitted and before the
	// ready transaction starts, so a test can rotate the verifier in between.
	// It must not touch the hub lock.
	TestBeforeReadyWrite func()
	// TestDuringReadyTx runs inside the open ready transaction after
	// ValidatePrincipalTx and before the column updates. The per-machine lock
	// is held.
	TestDuringReadyTx func()
}

// PresenceStore persists machine presence facts with short local
// transactions. No SQLite transaction is ever held across a network
// operation; every method is a short statement or a single transaction with
// the principal revalidated inside it.
type PresenceStore struct {
	db    *sql.DB
	hooks PresenceOptions
}

// NewPresenceStore builds the presence facts store over the shared handle.
// A nil handle is a construction failure: a non-nil store wrapping a nil
// database would silently bypass the Hub's required-Facts check and panic on
// the first observation instead of failing at assembly.
func NewPresenceStore(db *sql.DB, opts PresenceOptions) (*PresenceStore, error) {
	if db == nil {
		return nil, fmt.Errorf("computer: presence store requires a database handle")
	}
	return &PresenceStore{db: db, hooks: opts}, nil
}

// ApplyReady persists the ready facts plus the computer-version refresh in
// one transaction. The runtimes column is written even when empty (a daemon
// reporting zero runtimes clears the column — TS behavior).
func (f *PresenceStore) ApplyReady(ctx context.Context, facts ReadyFacts, principal Principal) error {
	runtimesJSON, err := json.Marshal(facts.Runtimes)
	if err != nil {
		return fmt.Errorf("encode runtimes: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.hooks.TestBeforeReadyWrite != nil {
		f.hooks.TestBeforeReadyWrite()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := validatePresenceTargetTx(ctx, tx, principal, facts.MachineID); err != nil {
		return err
	}
	if f.hooks.TestDuringReadyTx != nil {
		f.hooks.TestDuringReadyTx()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.hooks.TestFailReady != nil && f.hooks.TestFailReady.Load() > 0 {
		f.hooks.TestFailReady.Add(-1)
		return errors.New("presence: injected ready persistence failure")
	}

	set := "runtimes = ?"
	args := []any{string(runtimesJSON)}
	if facts.Hostname != nil {
		set += ", hostname = ?"
		args = append(args, *facts.Hostname)
	}
	if facts.OS != nil {
		set += ", os = ?"
		args = append(args, *facts.OS)
	}
	if facts.DaemonVersion != nil {
		set += ", daemon_version = ?"
		args = append(args, *facts.DaemonVersion)
	}
	args = append(args, facts.MachineID)
	res, err := tx.ExecContext(ctx, "UPDATE machines SET "+set+" WHERE id = ?", args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("presence: machine row %q missing for ready facts", facts.MachineID)
	}
	if err := f.recordComputerVersionTx(ctx, tx, facts.MachineID, facts.ComputerVersion, facts.ObservedAt); err != nil {
		return err
	}
	return tx.Commit()
}

// recordComputerVersionTx ports recordMachineComputerVersion: trim; empty
// skips; write only when the version CHANGED (null-safe) or the last report
// is missing or >= 24h old.
func (f *PresenceStore) recordComputerVersionTx(ctx context.Context, tx *sql.Tx, machineID, rawVersion string, reportedAt time.Time) error {
	version := strings.TrimSpace(rawVersion)
	if version == "" {
		return nil
	}
	refreshBefore := reportedAt.Add(-ComputerVersionRefreshInterval).UnixMilli()
	res, err := tx.ExecContext(ctx, `
		UPDATE machines
		SET computer_version = ?, computer_version_reported_at = ?
		WHERE id = ?
		  AND (computer_version IS NOT ?
		       OR computer_version_reported_at IS NULL
		       OR computer_version_reported_at < ?)`,
		version, reportedAt.UnixMilli(), machineID, version, refreshBefore)
	if err != nil {
		return err
	}
	_ = res // rows-affected 0 is the normal "nothing changed" path
	return nil
}

// TouchHeartbeat ports updateHeartbeat: last_heartbeat = now. The principal
// is revalidated inside the write transaction so a rotation that commits
// first cannot be followed by this heartbeat.
func (f *PresenceStore) TouchHeartbeat(ctx context.Context, machineID string, at time.Time, principal Principal) error {
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := validatePresenceTargetTx(ctx, tx, principal, machineID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE machines SET last_heartbeat = ? WHERE id = ?`, at.UnixMilli(), machineID); err != nil {
		return err
	}
	return tx.Commit()
}

// RecordStatusTransition ports recordMachineStatusTransition exactly:
//
//   - a write older than the stored status_changed_at is dropped;
//   - "online" transitions only when the stored status differs, the since is
//     missing, or the last heartbeat is older than the 3-minute continuity
//     window (a quick reconnect keeps the original since);
//   - "offline" transitions only when the stored status differs or since is
//     missing.
//
// found is false when the machine row does not exist.
func (f *PresenceStore) RecordStatusTransition(ctx context.Context, machineID, status string, at time.Time, principal Principal) (record StatusRecord, found bool, err error) {
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		return StatusRecord{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := validatePresenceTargetTx(ctx, tx, principal, machineID); err != nil {
		return StatusRecord{}, false, err
	}

	var lastStatus sql.NullString
	var statusChangedAt sql.NullInt64
	var lastHeartbeat sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT last_status, status_changed_at, last_heartbeat FROM machines WHERE id = ?`,
		machineID).Scan(&lastStatus, &statusChangedAt, &lastHeartbeat)
	if err == sql.ErrNoRows {
		return StatusRecord{}, false, nil
	}
	if err != nil {
		return StatusRecord{}, false, err
	}
	stored := StatusRecord{LastStatus: lastStatus, StatusChangedAt: statusChangedAt}
	if statusChangedAt.Valid && statusChangedAt.Int64 > at.UnixMilli() {
		return stored, true, nil
	}
	var transitioned bool
	if status == "online" {
		heartbeatStale := !lastHeartbeat.Valid ||
			lastHeartbeat.Int64 < at.Add(-onlineContinuity).UnixMilli()
		transitioned = !lastStatus.Valid || lastStatus.String != "online" ||
			!statusChangedAt.Valid || heartbeatStale
	} else {
		transitioned = !lastStatus.Valid || lastStatus.String != "offline" || !statusChangedAt.Valid
	}
	if !transitioned {
		return stored, true, nil
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE machines SET last_status = ?, status_changed_at = ? WHERE id = ?`,
		status, at.UnixMilli(), machineID); err != nil {
		return StatusRecord{}, true, err
	}
	if err := tx.Commit(); err != nil {
		return StatusRecord{}, true, err
	}
	return StatusRecord{
		LastStatus:      sql.NullString{String: status, Valid: true},
		StatusChangedAt: sql.NullInt64{Int64: at.UnixMilli(), Valid: true},
	}, true, nil
}

// validatePresenceTargetTx binds the mutation target to the same principal
// whose durable credential and workspace relationship were just checked.
// The caller still holds the Hub's current-connection fence; this extra
// domain check does not acquire a global authority fence or alter lock order.
func validatePresenceTargetTx(ctx context.Context, tx *sql.Tx, principal Principal, machineID string) error {
	if err := ValidatePrincipalTx(ctx, tx, principal); err != nil {
		return err
	}
	if machineID == principal.MachineID {
		return nil
	}
	if principal.Kind == KindComputer {
		return &AuthError{Reason: ReasonComputerMachineUnlinked, Stage: StageMachineLookup}
	}
	return &AuthError{Reason: ReasonMachineKeyInvalid, Stage: StageMachineLookup}
}

// Exists reports whether the machines row exists (Status/Send "offline" vs
// "unknown").
func (f *PresenceStore) Exists(ctx context.Context, machineID string) (bool, error) {
	var one int
	err := f.db.QueryRowContext(ctx,
		`SELECT 1 FROM machines WHERE id = ?`, machineID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
