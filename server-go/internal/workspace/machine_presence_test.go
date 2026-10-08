package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestM3MachinePresenceIsPerStoreNotGlobal(t *testing.T) {
	db := openSetupDB(t)
	setupSeedWorkspace(t, db, "ws", "owner")
	runtimes := `["claude"]`
	setupSeedMachine(t, db, "ws", "machine", "owner", &runtimes, nil, nil)
	setupSeedComputer(t, db, "ws", "computer", "machine", false)
	online := NewStoreWithOptions(db, Options{MachineStatusProbe: func(context.Context, string) (bool, error) { return true, nil }})
	offline := NewStoreWithOptions(db, Options{MachineStatusProbe: func(context.Context, string) (bool, error) { return false, nil }})
	legacy := NewStore(db)
	for _, tc := range []struct {
		store           *Store
		setupStatus     string
		directoryStatus string
	}{
		{online, ComputerStateOnline, ComputerStateOnline},
		{offline, ComputerStateOffline, ComputerStateOffline},
		{legacy, ComputerStateUnknown, ComputerStateOffline},
	} {
		projection, err := tc.store.GetSetupProjection(t.Context(), "ws", "owner")
		if err != nil || projection.ComputerStatus != tc.setupStatus {
			t.Fatalf("setup presence: %+v / %v", projection, err)
		}
		list, err := tc.store.ListMachines(t.Context(), "ws", "owner")
		if err != nil || len(list) != 1 || list[0]["status"] != tc.directoryStatus {
			t.Fatalf("directory presence: %v / %v", list, err)
		}
	}
	// The reads above are pure and cannot create a persisted online report.
	var reported any
	if err := db.QueryRow(`SELECT last_status FROM machines WHERE id='machine'`).Scan(&reported); err != nil || reported != nil {
		t.Fatalf("presence GET mutated persistent facts: %v / %v", reported, err)
	}
}

func TestM3MissingRuntimeReportIsArrayNotNull(t *testing.T) {
	db := openSetupDB(t)
	setupSeedWorkspace(t, db, "ws", "owner")
	setupSeedMachine(t, db, "ws", "machine", "owner", nil, nil, nil)
	store := NewStore(db)
	rows, err := store.ListMachines(t.Context(), "ws", "owner")
	if err != nil || len(rows) != 1 {
		t.Fatalf("directory: %v", err)
	}
	encoded, err := json.Marshal(rows[0]["runtimes"])
	if err != nil || string(encoded) != "[]" {
		t.Fatalf("absent runtime report must project as []: %s / %v", encoded, err)
	}
}

func TestM3FailedPresenceDoesNotClaimOnlineOrEmptyInventory(t *testing.T) {
	db := openSetupDB(t)
	setupSeedWorkspace(t, db, "ws", "owner")
	setupSeedMachine(t, db, "ws", "machine", "owner", nil, nil, nil)
	setupSeedComputer(t, db, "ws", "computer", "machine", false)
	store := NewStoreWithOptions(db, Options{MachineStatusProbe: func(context.Context, string) (bool, error) { return false, errors.New("presence unavailable") }})
	projection, err := store.GetSetupProjection(t.Context(), "ws", "owner")
	if err != nil || projection.ComputerStatus != ComputerStateUnknown || !projection.HasConnectedComputer || !projection.BlocksChat {
		t.Fatalf("unknown presence should retain connected-computer fact: %+v / %v", projection, err)
	}
	if _, err := store.ListMachines(t.Context(), "ws", "owner"); err == nil {
		t.Fatal("directory cannot turn a presence failure into empty inventory or fake online")
	}
}
