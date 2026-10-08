package workspace

import (
	"context"
	"database/sql"
	"reflect"
	"testing"
	"time"
)

func TestSetupResetDisconnectsOnlyNewlyRevokedBindingsAfterCommit(t *testing.T) {
	db := openSetupDB(t)
	// A callback cannot get this sole connection until the write transaction
	// has actually ended. Bound its read so a regression fails, not hangs.
	db.SetMaxOpenConns(1)
	s, _ := newSetupStore(t, db)
	setupSeedWorkspace(t, db, "ws", "owner")
	setupSeedWorkspace(t, db, "foreign", "other")
	setupSeedMachine(t, db, "ws", "live-machine", "owner", nil, nil, nil)
	setupSeedMachine(t, db, "ws", "old-machine", "owner", nil, nil, nil)
	setupSeedMachine(t, db, "foreign", "foreign-machine", "other", nil, nil, nil)
	setupSeedComputer(t, db, "ws", "live-computer", "live-machine", false)
	setupSeedComputer(t, db, "ws", "old-computer", "old-machine", true)
	setupSeedComputer(t, db, "ws", "unlinked-computer", "", false)
	setupSeedComputer(t, db, "foreign", "foreign-computer", "foreign-machine", false)

	var disconnected []string
	s.onComputerRevoked = func(machineID string) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		var remaining int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM computers WHERE workspace_id = 'ws' AND revoked_at IS NULL`).Scan(&remaining); err != nil {
			t.Errorf("revocation callback must run outside the transaction: %v", err)
		} else if remaining != 0 {
			t.Error("callback ran before credential revocation committed")
		}
		disconnected = append(disconnected, machineID)
	}
	result, err := s.ResetSetup(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if result.RevokedComputers != 2 {
		t.Fatalf("newly revoked computers = %d, want 2", result.RevokedComputers)
	}
	if !reflect.DeepEqual(disconnected, []string{"live-machine"}) {
		t.Fatalf("disconnected = %v; old, unlinked and foreign bindings must be untouched", disconnected)
	}
	var foreignRevocation sql.NullInt64
	if err := db.QueryRow(`SELECT revoked_at FROM computers WHERE id = 'foreign-computer'`).Scan(&foreignRevocation); err != nil || foreignRevocation.Valid {
		t.Fatalf("foreign credential changed: %v %v", foreignRevocation, err)
	}
	if _, err := s.ResetSetup(context.Background(), "ws", "owner"); err != nil {
		t.Fatal(err)
	}
	if len(disconnected) != 1 {
		t.Fatal("idempotent reset disconnected an already-revoked binding again")
	}
}

func TestSetupResetRollbackDoesNotDisconnect(t *testing.T) {
	db := openSetupDB(t)
	s, _ := newSetupStore(t, db)
	setupSeedWorkspace(t, db, "ws", "owner")
	setupSeedMachine(t, db, "ws", "machine", "owner", nil, nil, nil)
	setupSeedComputer(t, db, "ws", "computer", "machine", false)
	called := false
	s.onComputerRevoked = func(string) { called = true }
	// Abort after the credential update, at the second write in ResetSetup.
	if _, err := db.Exec(`CREATE TRIGGER fail_setup_reset BEFORE UPDATE OF status ON workspace_member_setup
		BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResetSetup(context.Background(), "ws", "owner"); err == nil {
		t.Fatal("injected late write failure was not returned")
	}
	if called {
		t.Fatal("a rolled-back reset disconnected the still-authorized client")
	}
	var revoked sql.NullInt64
	if err := db.QueryRow(`SELECT revoked_at FROM computers WHERE id = 'computer'`).Scan(&revoked); err != nil || revoked.Valid {
		t.Fatalf("failed reset persisted revocation: %v %v", revoked, err)
	}
}
