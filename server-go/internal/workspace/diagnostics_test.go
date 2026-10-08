package workspace_test

import (
	"context"
	"errors"
	"testing"

	"raft.local/server-go/internal/workspace"
)

func TestM2UpgradeDiagnosticsNeverRepairAuthorityOrPointers(t *testing.T) {
	handle := newWorkspaceDB(t)
	seedUser(t, handle, "user-a")
	store, _ := newTestStore(handle, workspace.Policy{})
	record, err := store.CreateWorkspace(t.Context(), "user-a", "Legacy", "legacy-review")
	if err != nil {
		t.Fatal(err)
	}
	if issues, err := store.Diagnose(t.Context()); err != nil || len(issues) != 0 {
		t.Fatalf("valid creation has unexpected diagnostics: %v %v", issues, err)
	}
	if _, err := handle.Exec(`UPDATE workspace_memberships SET role = 'member' WHERE workspace_id = ?`, record.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET onboarding_agent_id = 'unexplained-agent' WHERE id = ?`, record.ID); err != nil {
		t.Fatal(err)
	}
	issues, err := store.Diagnose(t.Context())
	if err != nil || len(issues) != 2 || issues[0].Code != "OWNER_MEMBERSHIP_INCONSISTENT" || issues[1].Code != "ONBOARDING_AGENT_REFERENCE_UNRESOLVED" {
		t.Fatalf("missing explicit legacy-data diagnostics: %#v %v", issues, err)
	}
	var role, pointer string
	if err := handle.QueryRow(`SELECT m.role, w.onboarding_agent_id FROM workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id WHERE w.id = ?`, record.ID).Scan(&role, &pointer); err != nil {
		t.Fatal(err)
	}
	if role != "member" || pointer != "unexplained-agent" {
		t.Fatal("read-only diagnostics silently changed authority or an unexplained pointer")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Diagnose(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("diagnostics must honor startup cancellation: %v", err)
	}
}
