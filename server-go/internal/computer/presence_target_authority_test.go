package computer

import (
	"database/sql"
	"testing"
	"time"
)

// Moving machine facts from a private Hub helper to an exported domain
// service must not create a confused-deputy API: a valid principal for A
// cannot update B merely because the caller supplied B as a separate target.
func TestPresenceFactsRejectDifferentTargetMachine(t *testing.T) {
	for _, principalKind := range []string{"computer", "legacy machine"} {
		for _, targetScope := range []string{"same workspace", "different workspace"} {
			t.Run(principalKind+"/"+targetScope, func(t *testing.T) {
				f := newFixture(t)
				f.seedUser(t, "presence-owner")
				f.seedWorkspace(t, "presence-a", "presence-alpha", "presence-owner")
				f.seedWorkspace(t, "presence-b", "presence-beta", "presence-owner")
				f.seedMembership(t, "presence-a", "presence-owner", "owner")
				f.seedMembership(t, "presence-b", "presence-owner", "owner")
				var principal Principal
				if principalKind == "computer" {
					attached, err := f.store.AttachComputer(t.Context(), "presence-owner", "presence-alpha", "Machine A")
					if err != nil {
						t.Fatal(err)
					}
					principal, err = f.store.Authenticate(t.Context(), attached.APIKey)
					if err != nil {
						t.Fatal(err)
					}
				} else {
					registered, err := f.store.RegisterMachine(t.Context(), "presence-a", "presence-owner", "Legacy A")
					if err != nil {
						t.Fatal(err)
					}
					principal, err = f.store.Authenticate(t.Context(), registered.APIKey)
					if err != nil {
						t.Fatal(err)
					}
				}
				targetSlug := "presence-alpha"
				if targetScope == "different workspace" {
					targetSlug = "presence-beta"
				}
				other, err := f.store.AttachComputer(t.Context(), "presence-owner", targetSlug, "Machine B")
				if err != nil {
					t.Fatal(err)
				}
				facts, err := NewPresenceStore(f.db, PresenceOptions{})
				if err != nil {
					t.Fatalf("presence store: %v", err)
				}
				at := f.fixed.Now().Add(time.Second)
				hostname := "observed-by-a"
				operations := []struct {
					name string
					run  func(string) error
				}{
					{"ready", func(target string) error {
						return facts.ApplyReady(t.Context(), ReadyFacts{
							MachineID: target, Runtimes: []string{"test-runtime"},
							Hostname: &hostname, ComputerVersion: "test-version", ObservedAt: at,
						}, principal)
					}},
					{"heartbeat", func(target string) error {
						return facts.TouchHeartbeat(t.Context(), target, at, principal)
					}},
					{"status", func(target string) error {
						_, _, err := facts.RecordStatusTransition(t.Context(), target, "online", at, principal)
						return err
					}},
				}
				for _, operation := range operations {
					t.Run(operation.name, func(t *testing.T) {
						before := presenceTargetSnapshot(t, f.db, other.MachineID)
						if err := operation.run(other.MachineID); err == nil {
							t.Error("valid principal for A was allowed to write facts for B")
						}
						if after := presenceTargetSnapshot(t, f.db, other.MachineID); after != before {
							t.Error("denied cross-target write changed B's persisted presence facts")
						}
						// Positive control: a service that rejects every call does
						// not satisfy the machine-facts contract either.
						if err := operation.run(principal.MachineID); err != nil {
							t.Fatalf("valid self-targeted presence write failed: %v", err)
						}
					})
				}
			})
		}
	}
}

type presenceObservedState struct {
	runtimes, hostname, computerVersion, status sql.NullString
	heartbeat, statusSince, versionReportedAt   sql.NullInt64
}

func presenceTargetSnapshot(t *testing.T, handle *sql.DB, id string) presenceObservedState {
	t.Helper()
	var state presenceObservedState
	if err := handle.QueryRowContext(t.Context(), `SELECT runtimes, hostname, computer_version,
		last_status, last_heartbeat, status_changed_at, computer_version_reported_at
		FROM machines WHERE id = ?`, id).Scan(&state.runtimes, &state.hostname,
		&state.computerVersion, &state.status, &state.heartbeat, &state.statusSince, &state.versionReportedAt); err != nil {
		t.Fatal(err)
	}
	return state
}
