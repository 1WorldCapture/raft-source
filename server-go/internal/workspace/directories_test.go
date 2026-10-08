// Machine directory behavioral tests (W17 / T23): real catalog queries,
// exact legacy field shapes, empty-catalog-is-[] honesty, revoked-computer
// linkage exclusion and cross-workspace isolation.
package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"testing"
)

func TestListMachinesEmptyCatalogIsBareEmptyArray(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	store, _ := newSetupStore(t, handle)

	machines, err := store.ListMachines(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if machines == nil {
		t.Fatal("empty catalog must be [] not null")
	}
	if len(machines) != 0 {
		t.Fatalf("%+v", machines)
	}
}

func TestListMachinesNonMemberAndDeletedWorkspace(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedWorkspace(t, handle, "gone", "owner2")
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 9 WHERE id = 'gone'`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)

	for _, tc := range []struct{ workspaceID, userID string }{
		{"ws", "stranger"}, {"gone", "owner2"}, {"nope", "owner"},
	} {
		_, err := store.ListMachines(context.Background(), tc.workspaceID, tc.userID)
		if code := mustDomainCode(t, err); code != CodeNotFound {
			t.Fatalf("%s/%s: code %s", tc.workspaceID, tc.userID, code)
		}
	}
}

func TestListMachinesRawDaemonFieldShape(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	runtimes := `["claude"]`
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, description, api_key_prefix,
		                      runtimes, hostname, os, daemon_version, last_heartbeat,
		                      last_status, status_changed_at, created_at)
		VALUES ('machine-1', 'ws', 'owner', 'Laptop', 'dev box', 'sk_machine_prefix',
		        ?, 'host-1', 'darwin', '1.2.3', 2000, NULL, NULL, 1000)`, runtimes); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)

	machines, err := store.ListMachines(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if len(machines) != 1 {
		t.Fatalf("%+v", machines)
	}
	m := machines[0]
	want := map[string]any{
		"id":                            "machine-1",
		"serverId":                      "ws",
		"userId":                        "owner",
		"name":                          "Laptop",
		"description":                   "dev box",
		"apiKeyPrefix":                  "sk_machine_prefix",
		"runtimes":                      []string{"claude"},
		"hostname":                      "host-1",
		"os":                            "darwin",
		"daemonVersion":                 "1.2.3",
		"lastHeartbeat":                 "1970-01-01T00:00:02.000Z",
		"createdAt":                     "1970-01-01T00:00:01.000Z",
		"status":                        "offline",
		"statusVersion":                 0,
		"runtimeVersions":               map[string]string{},
		"computerVersion":               nil,
		"hostKind":                      nil,
		"isComputer":                    false,
		"computerAttachedByCurrentUser": false,
		"agentCount":                    0,
		"creator":                       nil,
		// last_status NULL, no heartbeat-free state: never connected → the
		// offline period started at creation.
		"statusSince":              int64(2000),
		"computerUpgradeAvailable": nil,
		"computerBroadcastPolicy":  nil,
	}
	for key, wantVal := range want {
		gotVal, ok := m[key]
		if !ok {
			t.Fatalf("missing key %s in %v", key, keysOf(m))
		}
		switch gv := gotVal.(type) {
		case []string:
			wv := wantVal.([]string)
			if len(gv) != len(wv) {
				t.Fatalf("%s: %v want %v", key, gv, wv)
			}
			for i := range gv {
				if gv[i] != wv[i] {
					t.Fatalf("%s: %v want %v", key, gv, wv)
				}
			}
		default:
			if !reflect.DeepEqual(gotVal, wantVal) {
				t.Fatalf("%s: got %#v want %#v", key, gotVal, wantVal)
			}
		}
	}
	// The exact TS key set — no extras, no omissions.
	expectedKeys := []string{
		"id", "serverId", "userId", "name", "description", "apiKeyPrefix",
		"runtimes", "hostname", "os", "daemonVersion", "lastHeartbeat", "createdAt",
		"status", "statusVersion", "runtimeVersions", "computerVersion", "hostKind",
		"isComputer", "computerAttachedByCurrentUser", "agentCount", "creator",
		"statusSince", "computerUpgradeAvailable", "computerBroadcastPolicy",
	}
	if len(m) != len(expectedKeys) {
		t.Fatalf("key set drift: %v", keysOf(m))
	}
	for _, k := range expectedKeys {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing %s", k)
		}
	}
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func TestListMachinesComputerLinkageAndCreator(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMembership(t, handle, "ws", "teammate", "member")
	// Attach a computer on machine-1 as `teammate`; machine-2 stays raw.
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, runtimes, created_at)
		VALUES ('machine-1', 'ws', 'owner', 'M1', NULL, 1000),
		       ('machine-2', 'ws', 'owner', 'M2', NULL, 2000)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at)
		VALUES ('computer-1', 'ws', 'Maria-laptop', 'teammate', 'machine-1', 3000)`); err != nil {
		t.Fatal(err)
	}
	// Two agents on machine-1 (one deleted) + one unbound + one elsewhere.
	for _, row := range []struct {
		id, workspace, machine, deleted string
	}{
		{"agent-a", "ws", "machine-1", ""},
		{"agent-b", "ws", "machine-1", "yes"},
		{"agent-c", "ws", "", ""},
	} {
		var machine any
		if row.machine != "" {
			machine = row.machine
		}
		var deleted any
		if row.deleted != "" {
			deleted = int64(1)
		}
		if _, err := handle.Exec(`
			INSERT INTO agents (id, workspace_id, name, status, machine_id, deleted_at, created_at, updated_at)
			VALUES (?, ?, ?, 'active', ?, ?, 1, 1)`,
			row.id, row.workspace, row.id, machine, deleted); err != nil {
			t.Fatal(err)
		}
	}
	store, _ := newSetupStore(t, handle)

	machines, err := store.ListMachines(context.Background(), "ws", "teammate")
	if err != nil {
		t.Fatal(err)
	}
	if len(machines) != 2 {
		t.Fatalf("%+v", machines)
	}
	m1 := machines[0]
	if m1["id"] != "machine-1" {
		t.Fatalf("ordering must follow created_at: %v", keysOf(m1))
	}
	if m1["isComputer"] != true || m1["computerAttachedByCurrentUser"] != true {
		t.Fatalf("computer linkage: %+v", m1)
	}
	if m1["agentCount"] != 1 {
		t.Fatalf("agentCount counts non-deleted bound agents only: %v", m1["agentCount"])
	}
	creator, ok := m1["creator"].(computerCreatorSummary)
	if !ok {
		t.Fatalf("creator must be the public identity map: %#v", m1["creator"])
	}
	if creator.Type != "human" || creator.ID != "teammate" || creator.Name != "teammate" {
		t.Fatalf("%+v", creator)
	}
	email := "teammate@example.test"
	digest := sha256.Sum256([]byte(email))
	if creator.GravatarHash != hex.EncodeToString(digest[:]) {
		t.Fatalf("gravatar digest mismatch: %s", creator.GravatarHash)
	}
	// Managed computer: the TS-exact source_missing policy projection.
	policy, ok := m1["computerBroadcastPolicy"].(broadcastPolicyProjection)
	if !ok || policy.Eligibility != "no_broadcast" || policy.ReasonCode != "source_missing" {
		t.Fatalf("broadcast policy: %#v", m1["computerBroadcastPolicy"])
	}
	if m1["computerUpgradeAvailable"] != false {
		t.Fatalf("upgrade availability: %#v", m1["computerUpgradeAvailable"])
	}

	m2 := machines[1]
	if m2["isComputer"] != false || m2["creator"] != nil || m2["computerBroadcastPolicy"] != nil {
		t.Fatalf("raw daemon keeps null computer fields: %+v", m2)
	}
	// statusSince with no settled status and no heartbeat = creation time.
	if m2["statusSince"] != int64(2000) {
		t.Fatalf("statusSince: %#v", m2["statusSince"])
	}

	// A different requester sees the same machine without personal linkage.
	ownerView, err := store.ListMachines(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if ownerView[0]["computerAttachedByCurrentUser"] != false {
		t.Fatal("attachment flag is requester-scoped")
	}
}

func TestListMachinesRevokedComputerExcludedFromLinkage(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-1', 'ws', 'owner', 'M1', 1000)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`
		INSERT INTO computers (id, workspace_id, name, attached_by_user_id, machine_id, created_at, revoked_at)
		VALUES ('computer-1', 'ws', 'Old laptop', 'owner', 'machine-1', 1000, 5000)`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)

	machines, err := store.ListMachines(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	if machines[0]["isComputer"] != false || machines[0]["creator"] != nil {
		t.Fatalf("revoked computers lose linkage: %+v", machines[0])
	}
}

func TestListMachinesStatusSincePrecedence(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	cases := []struct {
		name       string
		lastStatus *string
		changedAt  *int64
		heartbeat  *int64
		want       any
	}{
		{"settled offline transition wins", strPtr("offline"), i64Ptr(7000), i64Ptr(6000), int64(7000)},
		{"heartbeat fallback", nil, nil, i64Ptr(6000), int64(6000)},
		{"never connected → creation", nil, nil, nil, int64(1000)},
		{"online disagreeing state has no start", strPtr("online"), i64Ptr(7000), nil, nil},
	}
	for _, tc := range cases {
		if _, err := handle.Exec(`
			INSERT INTO machines (id, workspace_id, user_id, name, last_status, status_changed_at, last_heartbeat, created_at)
			VALUES (?, 'ws', 'owner', ?, ?, ?, ?, 1000)`,
			"machine-"+tc.name, tc.name, tc.lastStatus, tc.changedAt, tc.heartbeat); err != nil {
			t.Fatal(err)
		}
	}
	store, _ := newSetupStore(t, handle)
	machines, err := store.ListMachines(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]any{}
	for _, m := range machines {
		byID[m["id"].(string)] = m
	}
	for _, tc := range cases {
		id := "machine-" + tc.name
		got, ok := byID[id]
		if !ok {
			t.Fatalf("%s missing", id)
		}
		if got["statusSince"] != tc.want {
			t.Fatalf("%s: statusSince %#v want %#v", tc.name, got["statusSince"], tc.want)
		}
	}
}

func TestListMachinesUnparseableRuntimesFailsLoudly(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, runtimes, created_at)
		VALUES ('machine-1', 'ws', 'owner', 'M1', 'not-json', 1000)`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	if _, err := store.ListMachines(context.Background(), "ws", "owner"); err == nil {
		t.Fatal("an unexplainable runtimes payload must fail, not silently report no machines")
	} else if AsDomainError(err) != nil {
		t.Fatalf("parse failure is infrastructure, not a domain answer: %v", err)
	}
}

func TestListMachinesCrossWorkspaceIsolation(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws-a", "owner-a")
	setupSeedWorkspace(t, handle, "ws-b", "owner-b")
	setupSeedMembership(t, handle, "ws-b", "owner-a", "member")
	if _, err := handle.Exec(`
		INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-b', 'ws-b', 'owner-b', 'B-only', 1000)`); err != nil {
		t.Fatal(err)
	}
	store, _ := newSetupStore(t, handle)
	machines, err := store.ListMachines(context.Background(), "ws-b", "owner-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(machines) != 1 || machines[0]["id"] != "machine-b" {
		t.Fatalf("directory is workspace-scoped: %+v", machines)
	}
}

func TestListMachinesNullRuntimesIsEmptyArray(t *testing.T) {
	handle := openSetupDB(t)
	setupSeedWorkspace(t, handle, "ws", "owner")
	setupSeedMachine(t, handle, "ws", "machine-1", "owner", nil, nil, nil)
	store, _ := newSetupStore(t, handle)
	machines, err := store.ListMachines(context.Background(), "ws", "owner")
	if err != nil {
		t.Fatal(err)
	}
	runtimes, ok := machines[0]["runtimes"].([]string)
	if !ok || len(runtimes) != 0 {
		t.Fatalf("NULL runtimes must render []: %#v", machines[0]["runtimes"])
	}
}

func strPtr(s string) *string { return &s }

func i64Ptr(v int64) *int64 { return &v }
