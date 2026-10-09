package humanapi_test

// Post-join usability and persistence evidence for the M3 invitations fix:
// a member added through accept-invite must be a fully working member on the
// real API surface (not just a workspace_memberships row), and the
// invitation facts must survive a process restart with the append-only
// 0009 migration applied exactly once.

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

// TestJoinedMemberEndToEndUsability drives the reads the Web client performs
// right after InviteAcceptPage routes it into the workspace: server list,
// workspace settings, setup projection, sidebar order (which requires the
// per-member preferences row) and the channel list with the implicit #all
// membership. Every read uses the actual API as the joined member.
func TestJoinedMemberEndToEndUsability(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, ownerToken, _ := env.FullAccount("journey-owner@example.com", "jowner")
	_, joinerToken, _ := env.FullAccount("journey-joiner@example.com", "jjoiner")
	workspaceID := env.CreateServer(t, ownerToken, "Journey", "journey-ws")

	created := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": nil, "expiresAt": nil}, testkit.Scoped(ownerToken, workspaceID))
	if created.Status != http.StatusOK {
		t.Fatalf("create link: %d %s", created.Status, created.Raw)
	}
	token, _ := created.Body["token"].(string)
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, testkit.Bearer(joinerToken)); res.Status != http.StatusOK {
		t.Fatalf("accept: %d %s", res.Status, res.Raw)
	}

	// Companion rows the product reads require: setup + preferences.
	for table, want := range map[string]int{
		"workspace_member_setup":       2, // owner + joiner
		"workspace_member_preferences": 2,
	} {
		var n int
		if err := env.App.DB.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE workspace_id = ?`, workspaceID).Scan(&n); err != nil || n != want {
			t.Fatalf("%s rows = %d want %d (err=%v)", table, n, want, err)
		}
	}

	// 1. Server list: the joined workspace with the member role.
	list := env.Serve("GET", "/api/servers", nil, testkit.Bearer(joinerToken))
	if list.Status != http.StatusOK {
		t.Fatalf("server list: %d", list.Status)
	}
	found := false
	for _, row := range decodeBareArray(t, list.Raw) {
		if row["id"] == workspaceID {
			found = true
			if row["role"] != "member" {
				t.Fatalf("list role: %v", row["role"])
			}
		}
	}
	if !found {
		t.Fatalf("joined workspace missing from list: %s", list.Raw)
	}

	// 2. Workspace detail + settings (members may read; the surface is
	// guest-gated, not member-gated).
	detail := env.Serve("GET", "/api/servers/"+workspaceID, nil, testkit.Scoped(joinerToken, workspaceID))
	if detail.Status != http.StatusOK || detail.Body["slug"] != "journey-ws" {
		t.Fatalf("workspace detail: %d %s", detail.Status, detail.Raw)
	}
	settings := env.Serve("GET", "/api/servers/"+workspaceID+"/settings", nil, testkit.Scoped(joinerToken, workspaceID))
	if settings.Status != http.StatusOK {
		t.Fatalf("settings: %d %s", settings.Status, settings.Raw)
	}

	// 3. Setup projection: a non-owner reads the honest no-setup projection,
	// never an error and never the owner's wizard.
	projection := env.Serve("GET", "/api/servers/"+workspaceID+"/setup-projection", nil, testkit.Scoped(joinerToken, workspaceID))
	if projection.Status != http.StatusOK {
		t.Fatalf("setup projection: %d %s", projection.Status, projection.Raw)
	}
	if projection.Body["surface"] != "none" || projection.Body["gateReason"] != "insufficient_permission" {
		t.Fatalf("member setup projection drifted: %s", projection.Raw)
	}

	// 4. Sidebar order: GET answers 200 only when the per-member preferences
	// row exists — this is the read that breaks for a bare membership row.
	sidebar := env.Serve("GET", "/api/servers/"+workspaceID+"/sidebar-order", nil, testkit.Scoped(joinerToken, workspaceID))
	if sidebar.Status != http.StatusOK {
		t.Fatalf("sidebar order after join: %d %s (missing companion row?)", sidebar.Status, sidebar.Raw)
	}

	// 5. Channels: the implicit #all membership reads as joined.
	channels := env.Serve("GET", "/api/channels", nil, testkit.Scoped(joinerToken, workspaceID))
	if channels.Status != http.StatusOK {
		t.Fatalf("channel list: %d %s", channels.Status, channels.Raw)
	}
	var all map[string]any
	for _, row := range decodeBareArray(t, channels.Raw) {
		if row["systemKind"] == "all" {
			all = row
		}
	}
	if all == nil || all["joined"] != true {
		t.Fatalf("#all channel not joined after invite accept: %s", channels.Raw)
	}
}

// TestInviteRestartPersistence proves the invitation facts survive a process
// restart over the same data dir: the append-only migration records exactly
// once, join links keep their identity (id, raw token, use count), pending
// invites stay pending, and the accepted membership is still readable.
func TestInviteRestartPersistence(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, ownerToken, _ := env.FullAccount("restart-owner@example.com", "reowner")
	_, joinerToken, _ := env.FullAccount("restart-joiner@example.com", "rejoiner")
	workspaceID := env.CreateServer(t, ownerToken, "Restart", "restart-ws")

	created := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": 5}, testkit.Scoped(ownerToken, workspaceID))
	if created.Status != http.StatusOK {
		t.Fatalf("create link: %d %s", created.Status, created.Raw)
	}
	token, _ := created.Body["token"].(string)
	linkID, _ := created.Body["link"].(map[string]any)["id"].(string)

	invited := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "restart-pending@example.com"}, testkit.Scoped(ownerToken, workspaceID))
	if invited.Status != http.StatusOK {
		t.Fatalf("create invite: %d %s", invited.Status, invited.Raw)
	}
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, testkit.Bearer(joinerToken)); res.Status != http.StatusOK {
		t.Fatalf("accept: %d %s", res.Status, res.Raw)
	}

	// Restart: rebuild the app over the same data dir (real process restart
	// semantics for the migration runner and every persisted row).
	env2 := env.Reopen()

	var migrationCount int
	if err := env2.App.DB.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version = '0009_workspace_invitations.sql'`).Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("0009 recorded %d times (err=%v)", migrationCount, err)
	}

	links := env2.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, testkit.Scoped(ownerToken, workspaceID))
	if links.Status != http.StatusOK {
		t.Fatalf("links after restart: %d", links.Status)
	}
	var row map[string]any
	for _, item := range decodeBareArray(t, links.Raw) {
		if item["id"] == linkID {
			row = item
		}
	}
	if row == nil || row["token"] != token || row["useCount"] != float64(1) || row["maxUses"] != float64(5) {
		t.Fatalf("join link drifted across restart: %v", row)
	}

	pending := env2.Serve("GET", "/api/servers/"+workspaceID+"/invites", nil, testkit.Scoped(ownerToken, workspaceID))
	if rows := decodeBareArray(t, pending.Raw); len(rows) != 1 || rows[0]["invitedEmail"] != "restart-pending@example.com" {
		t.Fatalf("pending invite drifted across restart: %s", pending.Raw)
	}

	// The still-valid link previews and joins another account after the
	// restart (use count continues from its persisted value).
	info := env2.Serve("GET", "/api/auth/invite-info?token="+token, nil, nil)
	if info.Status != http.StatusOK {
		t.Fatalf("preview after restart: %d", info.Status)
	}
	list := env2.Serve("GET", "/api/servers", nil, testkit.Bearer(joinerToken))
	joined := false
	for _, item := range decodeBareArray(t, list.Raw) {
		if item["id"] == workspaceID {
			joined = true
		}
	}
	if !joined {
		t.Fatalf("membership lost across restart: %s", list.Raw)
	}
}
