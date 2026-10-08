package workspace

import (
	"context"
	"testing"
)

func TestM3MachineDirectoryUsesOnlyCurrentConnectionMetadata(t *testing.T) {
	db := openSetupDB(t)
	setupSeedWorkspace(t, db, "ws", "owner")
	setupSeedMachine(t, db, "ws", "machine", "owner", nil, nil, nil)
	setupSeedComputer(t, db, "ws", "computer", "machine", false)
	if _, err := db.Exec(`UPDATE machines SET os='darwin arm64', computer_version='old-persisted-version' WHERE id='machine'`); err != nil {
		t.Fatal(err)
	}
	live := &LiveMachineMetadata{
		WorkspaceID: "ws", ComputerVersion: "2.3.4", DaemonVersion: "3.4.5", HostKind: "standalone",
		RuntimeVersions: map[string]string{"claude": "4.5.6"}, StatusVersion: 7,
	}
	store := NewStoreWithOptions(db, Options{
		MachineStatusProbe: func(context.Context, string) (bool, error) { return true, nil },
		MachineMetadata:    func(context.Context, string) (*LiveMachineMetadata, error) { return live, nil },
	})
	list, err := store.ListMachines(t.Context(), "ws", "owner")
	if err != nil || len(list) != 1 {
		t.Fatalf("directory: %v", err)
	}
	item := list[0]
	if item["computerVersion"] != "2.3.4" || item["daemonVersion"] != "3.4.5" || item["statusVersion"] != int64(7) || item["hostKind"] != "standalone" {
		t.Fatalf("live metadata not projected: %v", item)
	}
	policy, ok := item["computerBroadcastPolicy"].(broadcastPolicyProjection)
	if !ok || policy.ReasonCode != "hands_unavailable" || policy.Eligibility != "no_broadcast" {
		t.Fatalf("missing local upgrade authority is not missing source: %v", policy)
	}
	live.RuntimeVersions["claude"] = "next-generation"
	if item["runtimeVersions"].(map[string]string)["claude"] != "4.5.6" {
		t.Fatal("projection aliases mutable connection metadata")
	}
	live = nil // a disconnect between the presence and metadata reads
	list, err = store.ListMachines(t.Context(), "ws", "owner")
	if err != nil || list[0]["computerVersion"] != nil || list[0]["status"] != ComputerStateOffline {
		t.Fatalf("disconnected metadata was resurrected from database: %v / %v", list, err)
	}
	live = &LiveMachineMetadata{WorkspaceID: "different-space"}
	if _, err := store.ListMachines(t.Context(), "ws", "owner"); err == nil {
		t.Fatal("foreign connection metadata must not cross workspace boundary")
	}
}

func TestLocalComputerUpgradePolicyPreservesReferenceGuardOrder(t *testing.T) {
	for _, tc := range []struct{ version, host, os, want string }{
		{"", "desktop_app", "", "app_managed"},
		{"", "standalone", "darwin arm64", "source_missing"},
		{"nonsense", "standalone", "darwin arm64", "source_unparseable"},
		{"1.02.3", "standalone", "darwin arm64", "source_unparseable"},
		{"1.2.3-01", "standalone", "darwin arm64", "source_unparseable"},
		{"1.2.3", "standalone", "darwin", "platform_unknown"},
		{"1.2.3", "standalone", "freebsd arm64", "platform_unknown"},
		{"1.2.3", "standalone", "darwin arm64", "hands_unavailable"},
		{"1.2.3-rc.1", "standalone", "linux-x86_64", "hands_unavailable"},
		{"1.2.3+build.01", "standalone", "Windows x64", "hands_unavailable"},
	} {
		if got := localComputerUpgradeReason(tc.version, tc.host, tc.os); got != tc.want {
			t.Errorf("%+v: got %s", tc, got)
		}
	}
}
