package machinews

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"raft.local/server-go/internal/computer"
)

// machineFacts is the owned machine-connection write boundary on the REAL
// machines row (migration 0004). Ports:
//   - machineService.updateMachineRuntimes (ready facts)
//   - machineService.recordMachineComputerVersion (24h refresh rule)
//   - machineService.updateHeartbeat (pong)
//   - machineService.recordMachineStatusTransition (online/offline with the
//     monotonic since-guard and the 3-minute online continuity rule)
//
// No SQLite transaction is ever held across a network operation; every
// method is a short statement or a single BEGIN IMMEDIATE transaction.
type machineFacts struct {
	db *sql.DB
	// testFailReady, when positive, fails that many ready writes after the
	// principal recheck and before any column update. Production leaves it 0.
	testFailReady atomic.Int32
	// testBeforeReadyWrite runs after the caller was admitted and before the
	// ready transaction starts, so a test can rotate the verifier in between.
	// Production leaves it nil. It must not touch the hub lock.
	testBeforeReadyWrite func()
	// testDuringReadyTx runs inside the open ready transaction after
	// ValidatePrincipalTx and before the column updates. The per-machine
	// lock is held. Production leaves it nil.
	testDuringReadyTx func()
}

// statusRecord mirrors machineService.MachineStatusRecord.
type statusRecord struct {
	LastStatus      sql.NullString
	StatusChangedAt sql.NullInt64
}

// readyFacts is one ready frame's persistable projection. nil pointers mean
// "absent from the frame" — the column keeps its previous value (TS
// `!== undefined` semantics). Runtimes is always written (the TS column
// write is unconditional; ready without a runtimes array is invalid).
type readyFacts struct {
	MachineID       string
	Runtimes        []string
	Hostname        *string
	OS              *string
	DaemonVersion   *string
	ComputerVersion string // "" = not reported this frame
	ObservedAt      time.Time
}

// applyReady persists the ready facts plus the computer-version refresh in
// one transaction. The runtimes column is written even when empty (a daemon
// reporting zero runtimes clears the column — TS behavior).
func (f *machineFacts) applyReady(ctx context.Context, facts readyFacts, principal computer.Principal) error {
	runtimesJSON, err := json.Marshal(facts.Runtimes)
	if err != nil {
		return fmt.Errorf("encode runtimes: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.testBeforeReadyWrite != nil {
		f.testBeforeReadyWrite()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := computer.ValidatePrincipalTx(ctx, tx, principal); err != nil {
		return err
	}
	if f.testDuringReadyTx != nil {
		f.testDuringReadyTx()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.testFailReady.Load() > 0 {
		f.testFailReady.Add(-1)
		return errors.New("machinews: injected ready persistence failure")
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
		return fmt.Errorf("machinews: machine row %q missing for ready facts", facts.MachineID)
	}
	if err := f.recordComputerVersionTx(ctx, tx, facts.MachineID, facts.ComputerVersion, facts.ObservedAt); err != nil {
		return err
	}
	return tx.Commit()
}

// recordComputerVersionTx ports recordMachineComputerVersion: trim; empty
// skips; write only when the version CHANGED (null-safe) or the last report
// is missing or >= 24h old.
func (f *machineFacts) recordComputerVersionTx(ctx context.Context, tx *sql.Tx, machineID, rawVersion string, reportedAt time.Time) error {
	version := strings.TrimSpace(rawVersion)
	if version == "" {
		return nil
	}
	refreshBefore := reportedAt.Add(-computerVersionRefreshInterval).UnixMilli()
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

// touchHeartbeat ports updateHeartbeat: last_heartbeat = now. The principal
// is revalidated inside the write transaction so a rotation that commits
// first cannot be followed by this heartbeat.
func (f *machineFacts) touchHeartbeat(ctx context.Context, machineID string, at time.Time, principal computer.Principal) error {
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := computer.ValidatePrincipalTx(ctx, tx, principal); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE machines SET last_heartbeat = ? WHERE id = ?`, at.UnixMilli(), machineID); err != nil {
		return err
	}
	return tx.Commit()
}

// recordStatusTransition ports recordMachineStatusTransition exactly:
//
//   - a write older than the stored status_changed_at is dropped;
//   - "online" transitions only when the stored status differs, the since is
//     missing, or the last heartbeat is older than the 3-minute continuity
//     window (a quick reconnect keeps the original since);
//   - "offline" transitions only when the stored status differs or since is
//     missing.
//
// found is false when the machine row does not exist.
func (f *machineFacts) recordStatusTransition(ctx context.Context, machineID, status string, at time.Time, principal computer.Principal) (record statusRecord, found bool, err error) {
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		return statusRecord{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := computer.ValidatePrincipalTx(ctx, tx, principal); err != nil {
		return statusRecord{}, false, err
	}

	var lastStatus sql.NullString
	var statusChangedAt sql.NullInt64
	var lastHeartbeat sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT last_status, status_changed_at, last_heartbeat FROM machines WHERE id = ?`,
		machineID).Scan(&lastStatus, &statusChangedAt, &lastHeartbeat)
	if err == sql.ErrNoRows {
		return statusRecord{}, false, nil
	}
	if err != nil {
		return statusRecord{}, false, err
	}
	stored := statusRecord{LastStatus: lastStatus, StatusChangedAt: statusChangedAt}
	if statusChangedAt.Valid && statusChangedAt.Int64 > at.UnixMilli() {
		return stored, true, nil
	}
	var transitioned bool
	if status == "online" {
		heartbeatStale := !lastHeartbeat.Valid ||
			lastHeartbeat.Int64 < at.Add(-machineOnlineContinuity).UnixMilli()
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
		return statusRecord{}, true, err
	}
	if err := tx.Commit(); err != nil {
		return statusRecord{}, true, err
	}
	return statusRecord{
		LastStatus:      sql.NullString{String: status, Valid: true},
		StatusChangedAt: sql.NullInt64{Int64: at.UnixMilli(), Valid: true},
	}, true, nil
}

// machineExists reports whether the machines row exists (Status/Send
// "offline" vs "unknown").
func (f *machineFacts) machineExists(ctx context.Context, machineID string) (bool, error) {
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
