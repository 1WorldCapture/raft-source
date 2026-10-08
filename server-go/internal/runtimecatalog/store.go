package runtimecatalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	maxPersistedRuntimes = 256
	maxRuntimeIDLength   = 128
)

// ErrUnparseableRuntimes means the machines.runtimes column is not a JSON
// string array. Callers must fail the request rather than treat it as an
// empty successful capability list.
var ErrUnparseableRuntimes = errors.New("runtimecatalog: machine runtimes are unparseable")

// Store reads persisted machines, agents and memberships. It does not write.
type Store struct {
	db *sql.DB
}

// NewStore binds the catalog reader to the process SQLite handle.
func NewStore(db *sql.DB) *Store {
	if db == nil {
		panic("runtimecatalog: nil db")
	}
	return &Store{db: db}
}

// Machine is one machines row. RuntimesReported is false when the column is
// NULL (the Computer has not reported a list). RuntimeIDs is the persisted
// array only — never a live connection snapshot.
type Machine struct {
	ID               string
	WorkspaceID      string
	UserID           string
	RuntimesReported bool
	RuntimeIDs       []string
	DaemonVersion    *string
	ComputerVersion  *string
}

// Agent is the identity needed to project an existing agent's runtime options.
type Agent struct {
	ID          string
	WorkspaceID string
	Runtime     string
	MachineID   *string
}

// MemberRole returns the caller's role in a live, non-joint workspace.
// A missing membership, a deleted workspace and joint_storage all return
// ("", nil).
func (s *Store) MemberRole(ctx context.Context, workspaceID, userID string) (string, error) {
	var role string
	err := s.db.QueryRowContext(ctx, `
		SELECT m.role
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
		workspaceID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("runtimecatalog: member role: %w", err)
	}
	return role, nil
}

// Machine loads one machine by id. A missing row is (nil, nil).
func (s *Store) Machine(ctx context.Context, id string) (*Machine, error) {
	var machine Machine
	var runtimes sql.NullString
	var daemon, computer sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, user_id, runtimes, daemon_version, computer_version
		FROM machines WHERE id = ?`, id).Scan(
		&machine.ID, &machine.WorkspaceID, &machine.UserID, &runtimes, &daemon, &computer)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("runtimecatalog: machine: %w", err)
	}
	if daemon.Valid {
		machine.DaemonVersion = &daemon.String
	}
	if computer.Valid {
		machine.ComputerVersion = &computer.String
	}
	if !runtimes.Valid {
		return &machine, nil
	}
	ids, err := decodeRuntimeIDs(runtimes.String)
	if err != nil {
		return nil, err
	}
	machine.RuntimesReported = true
	machine.RuntimeIDs = ids
	return &machine, nil
}

// Agent loads a non-deleted agent. A missing or deleted row is (nil, nil).
func (s *Store) Agent(ctx context.Context, id string) (*Agent, error) {
	var agent Agent
	var machineID sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, runtime, machine_id
		FROM agents WHERE id = ? AND deleted_at IS NULL`, id).Scan(
		&agent.ID, &agent.WorkspaceID, &agent.Runtime, &machineID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("runtimecatalog: agent: %w", err)
	}
	if machineID.Valid && machineID.String != "" {
		agent.MachineID = &machineID.String
	}
	return &agent, nil
}

func decodeRuntimeIDs(raw string) ([]string, error) {
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return nil, ErrUnparseableRuntimes
	}
	if ids == nil {
		return nil, ErrUnparseableRuntimes
	}
	if len(ids) > maxPersistedRuntimes {
		return nil, ErrUnparseableRuntimes
	}
	for _, id := range ids {
		if id == "" || len(id) > maxRuntimeIDLength {
			return nil, ErrUnparseableRuntimes
		}
	}
	return ids, nil
}
