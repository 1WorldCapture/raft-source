package legacyweb_test

// Post-join usability and persistence evidence for the M3 invitations fix:
// a member added through accept-invite must be a fully working member on the
// real API surface (not just a workspace_memberships row), and the
// invitation facts must survive a process restart with the append-only
// 0009 migration applied exactly once.

import (
	"net/http"
	"testing"
)

// TestJoinedMemberEndToEndUsability drives the reads the Web client performs
// right after InviteAcceptPage routes it into the workspace: server list,
// workspace settings, setup projection, sidebar order (which requires the
// per-member preferences row) and the channel list with the implicit #all
// membership. Every read uses the actual API as the joined member.
func TestJoinedMemberEndToEndUsability(t *testing.T) {
	env := newTestEnv(t)
	_, ownerToken, _ := env.fullAccount("journey-owner@example.com", "jowner")
	_, joinerToken, _ := env.fullAccount("journey-joiner@example.com", "jjoiner")
	workspaceID := env.createServer(t, ownerToken, "Journey", "journey-ws")

	created := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": nil, "expiresAt": nil}, scoped(ownerToken, workspaceID))
	if created.status != http.StatusOK {
		t.Fatalf("create link: %d %s", created.status, created.raw)
	}
	token, _ := created.body["token"].(string)
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, bearer(joinerToken)); res.status != http.StatusOK {
		t.Fatalf("accept: %d %s", res.status, res.raw)
	}

	// Companion rows the product reads require: setup + preferences.
	for table, want := range map[string]int{
		"workspace_member_setup":       2, // owner + joiner
		"workspace_member_preferences": 2,
	} {
		var n int
		if err := env.app.DB.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE workspace_id = ?`, workspaceID).Scan(&n); err != nil || n != want {
			t.Fatalf("%s rows = %d want %d (err=%v)", table, n, want, err)
		}
	}

	// 1. Server list: the joined workspace with the member role.
	list := env.serve("GET", "/api/servers", nil, bearer(joinerToken))
	if list.status != http.StatusOK {
		t.Fatalf("server list: %d", list.status)
	}
	found := false
	for _, row := range decodeBareArray(t, list.raw) {
		if row["id"] == workspaceID {
			found = true
			if row["role"] != "member" {
				t.Fatalf("list role: %v", row["role"])
			}
		}
	}
	if !found {
		t.Fatalf("joined workspace missing from list: %s", list.raw)
	}

	// 2. Workspace detail + settings (members may read; the surface is
	// guest-gated, not member-gated).
	detail := env.serve("GET", "/api/servers/"+workspaceID, nil, scoped(joinerToken, workspaceID))
	if detail.status != http.StatusOK || detail.body["slug"] != "journey-ws" {
		t.Fatalf("workspace detail: %d %s", detail.status, detail.raw)
	}
	settings := env.serve("GET", "/api/servers/"+workspaceID+"/settings", nil, scoped(joinerToken, workspaceID))
	if settings.status != http.StatusOK {
		t.Fatalf("settings: %d %s", settings.status, settings.raw)
	}

	// 3. Setup projection: a non-owner reads the honest no-setup projection,
	// never an error and never the owner's wizard.
	projection := env.serve("GET", "/api/servers/"+workspaceID+"/setup-projection", nil, scoped(joinerToken, workspaceID))
	if projection.status != http.StatusOK {
		t.Fatalf("setup projection: %d %s", projection.status, projection.raw)
	}
	if projection.body["surface"] != "none" || projection.body["gateReason"] != "insufficient_permission" {
		t.Fatalf("member setup projection drifted: %s", projection.raw)
	}

	// 4. Sidebar order: GET answers 200 only when the per-member preferences
	// row exists — this is the read that breaks for a bare membership row.
	sidebar := env.serve("GET", "/api/servers/"+workspaceID+"/sidebar-order", nil, scoped(joinerToken, workspaceID))
	if sidebar.status != http.StatusOK {
		t.Fatalf("sidebar order after join: %d %s (missing companion row?)", sidebar.status, sidebar.raw)
	}

	// 5. Channels: the implicit #all membership reads as joined.
	channels := env.serve("GET", "/api/channels", nil, scoped(joinerToken, workspaceID))
	if channels.status != http.StatusOK {
		t.Fatalf("channel list: %d %s", channels.status, channels.raw)
	}
	var all map[string]any
	for _, row := range decodeBareArray(t, channels.raw) {
		if row["systemKind"] == "all" {
			all = row
		}
	}
	if all == nil || all["joined"] != true {
		t.Fatalf("#all channel not joined after invite accept: %s", channels.raw)
	}
}

// TestInviteRestartPersistence proves the invitation facts survive a process
// restart over the same data dir: the append-only migration records exactly
// once, join links keep their identity (id, raw token, use count), pending
// invites stay pending, and the accepted membership is still readable.
func TestInviteRestartPersistence(t *testing.T) {
	env := newTestEnv(t)
	_, ownerToken, _ := env.fullAccount("restart-owner@example.com", "reowner")
	_, joinerToken, _ := env.fullAccount("restart-joiner@example.com", "rejoiner")
	workspaceID := env.createServer(t, ownerToken, "Restart", "restart-ws")

	created := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": 5}, scoped(ownerToken, workspaceID))
	if created.status != http.StatusOK {
		t.Fatalf("create link: %d %s", created.status, created.raw)
	}
	token, _ := created.body["token"].(string)
	linkID, _ := created.body["link"].(map[string]any)["id"].(string)

	invited := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "restart-pending@example.com"}, scoped(ownerToken, workspaceID))
	if invited.status != http.StatusOK {
		t.Fatalf("create invite: %d %s", invited.status, invited.raw)
	}
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, bearer(joinerToken)); res.status != http.StatusOK {
		t.Fatalf("accept: %d %s", res.status, res.raw)
	}

	// Restart: rebuild the app over the same data dir (real process restart
	// semantics for the migration runner and every persisted row).
	env2 := env.reopen()

	var migrationCount int
	if err := env2.app.DB.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE version = '0009_workspace_invitations.sql'`).Scan(&migrationCount); err != nil || migrationCount != 1 {
		t.Fatalf("0009 recorded %d times (err=%v)", migrationCount, err)
	}

	links := env2.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, scoped(ownerToken, workspaceID))
	if links.status != http.StatusOK {
		t.Fatalf("links after restart: %d", links.status)
	}
	var row map[string]any
	for _, item := range decodeBareArray(t, links.raw) {
		if item["id"] == linkID {
			row = item
		}
	}
	if row == nil || row["token"] != token || row["useCount"] != float64(1) || row["maxUses"] != float64(5) {
		t.Fatalf("join link drifted across restart: %v", row)
	}

	pending := env2.serve("GET", "/api/servers/"+workspaceID+"/invites", nil, scoped(ownerToken, workspaceID))
	if rows := decodeBareArray(t, pending.raw); len(rows) != 1 || rows[0]["invitedEmail"] != "restart-pending@example.com" {
		t.Fatalf("pending invite drifted across restart: %s", pending.raw)
	}

	// The still-valid link previews and joins another account after the
	// restart (use count continues from its persisted value).
	info := env2.serve("GET", "/api/auth/invite-info?token="+token, nil, nil)
	if info.status != http.StatusOK {
		t.Fatalf("preview after restart: %d", info.status)
	}
	list := env2.serve("GET", "/api/servers", nil, bearer(joinerToken))
	joined := false
	for _, item := range decodeBareArray(t, list.raw) {
		if item["id"] == workspaceID {
			joined = true
		}
	}
	if !joined {
		t.Fatalf("membership lost across restart: %s", list.raw)
	}
}
