package humanapi_test

// Behavioral tests for the M3 invitations fix: join-link and email-invite
// management, the public preview and the logged-in accept path, driven
// through the fully wired handler (auth gates, scope, guest denial) with an
// in-process recorder. Contract pins come from the frozen TS routes
// (servers.ts join-links/invites, auth.ts invite-info/accept-invite) and the
// web consumers (InviteHumanDialog, SettingsPanel, InviteAcceptPage).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/mail"
)

// decodeBareArray parses a bare JSON array rec (list endpoints).
func decodeBareArray(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err != nil {
		t.Fatalf("bare array body: %v (%s)", err, raw)
	}
	return arr
}

// inviteOutboxToken returns the one-time raw invite token the mail delivery
// carried to the given address (the only place the raw value exists).
func inviteOutboxToken(t *testing.T, outbox, to string) string {
	t.Helper()
	entries, err := mail.ReadOutbox(outbox, 30)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	for _, entry := range entries {
		if entry.Kind == "invite" && entry.To == to && entry.Token != "" {
			return entry.Token
		}
	}
	t.Fatalf("no invite mail delivered to %s", to)
	return ""
}

func TestJoinLinkManagementAuthorization(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, ownerToken, _ := env.FullAccount("inv-owner@example.com", "invowner")
	memberID, memberToken, _ := env.FullAccount("inv-member@example.com", "invmember")
	guestID, guestToken, _ := env.FullAccount("inv-guest@example.com", "invguest")
	_, strangerToken, _ := env.FullAccount("inv-stranger@example.com", "invstranger")
	workspaceID := env.CreateServer(t, ownerToken, "Invites Auth", "invites-auth-ws")
	env.AddMember(t, workspaceID, memberID, "member")
	env.AddMember(t, workspaceID, guestID, "guest")

	// Unauthenticated and unscoped calls never reach the handler.
	if res := env.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, nil); res.Status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated list: %d", res.Status)
	}
	if res := env.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, testkit.Bearer(ownerToken)); res.Status != http.StatusBadRequest {
		t.Fatalf("missing X-Server-Id: %d", res.Status)
	}
	stranger := env.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, testkit.Scoped(strangerToken, workspaceID))
	if stranger.Status != http.StatusForbidden || stranger.Body["error"] != "Not a member of this server" {
		t.Fatalf("stranger scope: %d %v", stranger.Status, stranger.Body)
	}

	// Guests hit the management-surface denial; ordinary members hit the
	// capability sentence — both exact.
	if res := env.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, testkit.Scoped(guestToken, workspaceID)); res.Status != http.StatusForbidden || res.Body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest list: %d %v", res.Status, res.Body)
	}
	for _, tc := range []struct{ method, path, want string }{
		{"GET", "/join-links", "Only server owners and admins can view join links"},
		{"POST", "/join-links", "Only server owners and admins can create join links"},
		{"DELETE", "/join-links/x", "Only server owners and admins can revoke join links"},
		{"GET", "/invites", "Only server owners and admins can view invites"},
		{"POST", "/invites", "Only server owners and admins can send invites"},
		{"DELETE", "/invites/x", "Only server owners and admins can revoke invites"},
	} {
		// The TS email-invite route validates email before this capability
		// check; use a valid email so this matrix reaches authorization.
		res := env.Serve(tc.method, "/api/servers/"+workspaceID+tc.path, map[string]any{"email": "target@example.com"}, testkit.Scoped(memberToken, workspaceID))
		if res.Status != http.StatusForbidden || res.Body["error"] != tc.want {
			t.Fatalf("%s %s as member: %d %v", tc.method, tc.path, res.Status, res.Body)
		}
	}

	// The owner (and admin) may manage.
	if res := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": nil, "expiresAt": nil}, testkit.Scoped(ownerToken, workspaceID)); res.Status != http.StatusOK {
		t.Fatalf("owner create: %d %s", res.Status, res.Raw)
	}
}

func TestJoinLinkLifecycleAndLimits(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, ownerToken, _ := env.FullAccount("jl-owner@example.com", "jlowner")
	_, joinerToken, _ := env.FullAccount("jl-joiner@example.com", "jljoiner")
	_, secondJoinerToken, _ := env.FullAccount("jl-second@example.com", "jlsecond")
	workspaceID := env.CreateServer(t, ownerToken, "Join Links", "join-links-ws")

	// Body validation mirrors the TS route sentences.
	for _, body := range []map[string]any{
		{"maxUses": 0},
		{"maxUses": -3},
		{"maxUses": 2.5},
		{"maxUses": "abc"},
		{"maxUses": map[string]any{}},
	} {
		res := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", body, testkit.Scoped(ownerToken, workspaceID))
		if res.Status != http.StatusBadRequest || res.Body["error"] != "maxUses must be a positive integer" {
			t.Fatalf("maxUses %v: %d %v", body["maxUses"], res.Status, res.Body)
		}
	}
	badDate := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"expiresAt": "not-a-date"}, testkit.Scoped(ownerToken, workspaceID))
	if badDate.Status != http.StatusBadRequest || badDate.Body["error"] != "expiresAt must be a valid date" {
		t.Fatalf("expiresAt: %d %v", badDate.Status, badDate.Body)
	}

	// The UI dialog flow: GET (empty list) -> POST an unlimited link.
	empty := env.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, testkit.Scoped(ownerToken, workspaceID))
	if empty.Status != http.StatusOK || len(decodeBareArray(t, empty.Raw)) != 0 {
		t.Fatalf("empty list: %d %s", empty.Status, empty.Raw)
	}
	created := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": nil, "expiresAt": nil}, testkit.Scoped(ownerToken, workspaceID))
	if created.Status != http.StatusOK {
		t.Fatalf("create: %d %s", created.Status, created.Raw)
	}
	token, _ := created.Body["token"].(string)
	link, _ := created.Body["link"].(map[string]any)
	if token == "" || link == nil {
		t.Fatalf("create body missing token/link: %s", created.Raw)
	}
	for key, want := range map[string]any{"useCount": float64(0), "maxUses": nil, "expiresAt": nil, "revokedAt": nil} {
		if got, ok := link[key]; !ok || got != want {
			t.Fatalf("link.%s = %v (%T), want %v", key, got, got, want)
		}
	}
	if link["token"] != token {
		t.Fatalf("link.token %v != rec token %v (the UI rebuilds the URL from it)", link["token"], token)
	}
	if _, ok := link["createdAt"].(string); !ok {
		t.Fatalf("link.createdAt missing: %v", link["createdAt"])
	}

	// Public preview for the accept page.
	info := env.Serve("GET", "/api/auth/invite-info?token="+token, nil, nil)
	if info.Status != http.StatusOK || info.Body["kind"] != "join_link" {
		t.Fatalf("info: %d %s", info.Status, info.Raw)
	}
	if info.Body["serverName"] != "Join Links" {
		t.Fatalf("info serverName: %v", info.Body["serverName"])
	}
	if info.Body["insideCountsHidden"] != false || info.Body["agreement"] != nil || info.Body["humanSeatLimitReached"] != false {
		t.Fatalf("info defaults drifted: %s", info.Raw)
	}

	// Accept joins as member; a repeated accept stays idempotent and the use
	// count advances exactly once.
	accepted := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, testkit.Bearer(joinerToken))
	if accepted.Status != http.StatusOK || accepted.Body["serverId"] != workspaceID || accepted.Body["serverName"] != "Join Links" {
		t.Fatalf("accept: %d %s", accepted.Status, accepted.Raw)
	}
	if again := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, testkit.Bearer(joinerToken)); again.Status != http.StatusOK {
		t.Fatalf("idempotent re-accept: %d %s", again.Status, again.Raw)
	}
	links := env.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, testkit.Scoped(ownerToken, workspaceID))
	rows := decodeBareArray(t, links.Raw)
	if len(rows) != 1 {
		t.Fatalf("list length: %d (%s)", len(rows), links.Raw)
	}
	if rows[0]["token"] != token || rows[0]["useCount"] != float64(1) {
		t.Fatalf("listed link drifted: %v", rows[0])
	}

	// maxUses=1: the first joiner consumes it, everyone after gets the
	// legacy usage-limit sentence and the preview collapses to 404.
	limited := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": 1}, testkit.Scoped(ownerToken, workspaceID))
	if limited.Status != http.StatusOK {
		t.Fatalf("limited create: %d %s", limited.Status, limited.Raw)
	}
	limitedToken, _ := limited.Body["token"].(string)
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": limitedToken}, testkit.Bearer(secondJoinerToken)); res.Status != http.StatusOK {
		t.Fatalf("limited accept: %d %s", res.Status, res.Raw)
	}
	if res := env.Serve("GET", "/api/auth/invite-info?token="+limitedToken, nil, nil); res.Status != http.StatusNotFound {
		t.Fatalf("exhausted preview: %d", res.Status)
	}
	exhausted := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": limitedToken}, testkit.Bearer(joinerToken))
	if exhausted.Status != http.StatusBadRequest || exhausted.Body["error"] != "This invite has already reached its usage limit" {
		t.Fatalf("exhausted accept: %d %v", exhausted.Status, exhausted.Body)
	}

	// Expiry behaves identically (backdated row).
	expiring := env.Serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"expiresAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, testkit.Scoped(ownerToken, workspaceID))
	if expiring.Status != http.StatusOK {
		t.Fatalf("expiring create: %d %s", expiring.Status, expiring.Raw)
	}
	expiringLink, _ := expiring.Body["link"].(map[string]any)
	expiringToken, _ := expiring.Body["token"].(string)
	if _, err := env.App.DB.Exec(`UPDATE workspace_join_links SET expires_at = ? WHERE id = ?`, time.Now().Add(-time.Minute).UnixMilli(), expiringLink["id"]); err != nil {
		t.Fatal(err)
	}
	expired := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": expiringToken}, testkit.Bearer(secondJoinerToken))
	if expired.Status != http.StatusBadRequest || expired.Body["error"] != "This invite has expired" {
		t.Fatalf("expired accept: %d %v", expired.Status, expired.Body)
	}

	// Revocation removes the link from management and kills the token.
	linkID, _ := link["id"].(string)
	if res := env.Serve("DELETE", "/api/servers/"+workspaceID+"/join-links/"+linkID, nil, testkit.Scoped(ownerToken, workspaceID)); res.Status != http.StatusOK || res.Body["ok"] != true {
		t.Fatalf("revoke: %d %s", res.Status, res.Raw)
	}
	if res := env.Serve("GET", "/api/auth/invite-info?token="+token, nil, nil); res.Status != http.StatusNotFound || res.Body["error"] != "Invalid or expired invite" {
		t.Fatalf("info after revoke: %d %v", res.Status, res.Body)
	}
	revoked := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, testkit.Bearer(secondJoinerToken))
	if revoked.Status != http.StatusBadRequest || revoked.Body["error"] != "This invite has been revoked" {
		t.Fatalf("accept revoked: %d %v", revoked.Status, revoked.Body)
	}
	// The exhausted limited link is filtered too: the list is empty now.
	afterRevoke := env.Serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, testkit.Scoped(ownerToken, workspaceID))
	if rows := decodeBareArray(t, afterRevoke.Raw); len(rows) != 0 {
		t.Fatalf("revoked/exhausted links still listed: %s", afterRevoke.Raw)
	}
}

func TestEmailInviteFlow(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, ownerToken, _ := env.FullAccount("em-owner@example.com", "emowner")
	invitedID, invitedToken, _ := env.FullAccount("em-invited@example.com", "eminvited")
	_, otherToken, _ := env.FullAccount("em-other@example.com", "emother")
	workspaceID := env.CreateServer(t, ownerToken, "Email Invites", "email-invites-ws")
	env.AddMember(t, workspaceID, invitedID, "member")

	// Validation precedes persistence with the TS sentences.
	invalidEmail := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "not-an-email"}, testkit.Scoped(ownerToken, workspaceID))
	if invalidEmail.Status != http.StatusBadRequest || invalidEmail.Body["error"] != "Enter a valid email address" {
		t.Fatalf("invalid email: %d %v", invalidEmail.Status, invalidEmail.Body)
	}
	badRole := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "someone@example.com", "role": "admin"}, testkit.Scoped(ownerToken, workspaceID))
	if badRole.Status != http.StatusBadRequest || badRole.Body["error"] != "role must be one of: member, guest" {
		t.Fatalf("invalid role: %d %v", badRole.Status, badRole.Body)
	}
	// Frozen M3 guest gate: the TS route refuses guest invites while the
	// feature flag is disabled, and M3 freezes it disabled — same sentence,
	// same 400, no silent member downgrade, no row persisted.
	var guestRows int
	if err := env.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_invites WHERE role = 'guest'`).Scan(&guestRows); err != nil {
		t.Fatal(err)
	}
	guestCreate := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "would-be-guest@example.com", "role": "guest"}, testkit.Scoped(ownerToken, workspaceID))
	if guestCreate.Status != http.StatusBadRequest || guestCreate.Body["error"] != "Guest access is not enabled for this server" {
		t.Fatalf("guest create under disabled gate: %d %v", guestCreate.Status, guestCreate.Body)
	}
	var guestRowsAfter int
	if err := env.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_invites WHERE role = 'guest'`).Scan(&guestRowsAfter); err != nil {
		t.Fatal(err)
	}
	if guestRowsAfter != guestRows {
		t.Fatalf("guest invite persisted under disabled gate: %d -> %d", guestRows, guestRowsAfter)
	}
	// Inviting an address that already belongs to a member is the 409.
	if res := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "Em-Invited@Example.com"}, testkit.Scoped(ownerToken, workspaceID)); res.Status != http.StatusConflict || res.Body["error"] != "This user is already a member of this server" {
		t.Fatalf("member email invite: %d %v", res.Status, res.Body)
	}

	// A guest invite persisted by an earlier policy (or a direct write) must
	// also be refused at acceptance — explicitly, without downgrading the
	// join to member and without consuming or mutating the row.
	legacyGuestToken := "legacy-guest-invite-token-0123456789abcdef"
	digest := sha256.Sum256([]byte(legacyGuestToken))
	if _, err := env.App.DB.Exec(`
		INSERT INTO workspace_invites
			(id, workspace_id, invited_email, invited_by_user_id, role, token_digest, status, expires_at, created_at)
		VALUES (?, ?, ?, ?, 'guest', ?, 'pending', ?, ?)`,
		"legacy-guest-invite", workspaceID, "legacy-guest@example.com", invitedID,
		hex.EncodeToString(digest[:]), time.Now().Add(time.Hour).UnixMilli(), time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	legacyInfo := env.Serve("GET", "/api/auth/invite-info?token="+legacyGuestToken, nil, nil)
	if legacyInfo.Status != http.StatusOK || legacyInfo.Body["kind"] != "email" {
		t.Fatalf("legacy guest preview: %d %s", legacyInfo.Status, legacyInfo.Raw)
	}
	legacyAccept := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": legacyGuestToken}, testkit.Bearer(invitedToken))
	if legacyAccept.Status != http.StatusBadRequest || legacyAccept.Body["error"] != "Guest access is not enabled for this server" {
		t.Fatalf("legacy guest accept: %d %v", legacyAccept.Status, legacyAccept.Body)
	}
	var legacyStatus string
	var legacyMembership int
	if err := env.App.DB.QueryRow(`SELECT status FROM workspace_invites WHERE id = 'legacy-guest-invite'`).Scan(&legacyStatus); err != nil || legacyStatus != "pending" {
		t.Fatalf("legacy guest row mutated: %q err=%v", legacyStatus, err)
	}
	if err := env.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ?`, workspaceID).Scan(&legacyMembership); err != nil || legacyMembership != 2 { // owner + seeded member
		t.Fatalf("guest refusal must not create membership: %d err=%v", legacyMembership, err)
	}

	// Member invite for a fresh address: normalized email, rec shape and
	// real delivery through the private outbox.
	created := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "  outsider+Member@Example.com  "}, testkit.Scoped(ownerToken, workspaceID))
	if created.Status != http.StatusOK {
		t.Fatalf("create invite: %d %s", created.Status, created.Raw)
	}
	if created.Body["invitedEmail"] != "outsider+member@example.com" {
		t.Fatalf("email not normalized: %v", created.Body["invitedEmail"])
	}
	if created.Body["role"] != "member" {
		t.Fatalf("role: %v", created.Body["role"])
	}
	if _, ok := created.Body["expiresAt"].(string); !ok {
		t.Fatalf("create rec missing expiresAt: %s", created.Raw)
	}
	if _, hasToken := created.Body["token"]; hasToken {
		t.Fatalf("create rec leaked the raw token: %s", created.Raw)
	}
	rawToken := inviteOutboxToken(t, env.Outbox, "outsider+member@example.com")

	// Only the sha256 digest is stored; the raw token exists solely in mail.
	var stored string
	if err := env.App.DB.QueryRow(`SELECT token_digest FROM workspace_invites WHERE id = ?`, created.Body["id"]).Scan(&stored); err != nil {
		t.Fatalf("stored invite: %v", err)
	}
	if stored == rawToken || len(stored) != 64 {
		t.Fatalf("invite token stored in recoverable form: %q", stored)
	}

	// Email binding first: a different account cannot consume the invite.
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": rawToken}, testkit.Bearer(otherToken)); res.Status != http.StatusBadRequest || res.Body["error"] != "This invite was sent to a different email address" {
		t.Fatalf("wrong-email accept: %d %v", res.Status, res.Body)
	}

	// Pending list exposes the management projection.
	pending := env.Serve("GET", "/api/servers/"+workspaceID+"/invites", nil, testkit.Scoped(ownerToken, workspaceID))
	rows := decodeBareArray(t, pending.Raw)
	if len(rows) != 2 {
		t.Fatalf("pending list length (legacy guest + fresh member): %s", pending.Raw)
	}
	var memberRow map[string]any
	for _, row := range rows {
		if row["invitedEmail"] == "outsider+member@example.com" {
			memberRow = row
		}
	}
	if memberRow == nil || memberRow["status"] != "pending" || memberRow["role"] != "member" {
		t.Fatalf("pending member invite drifted: %s", pending.Raw)
	}

	// Preview shows the email kind with the inviter handle.
	info := env.Serve("GET", "/api/auth/invite-info?token="+rawToken, nil, nil)
	if info.Status != http.StatusOK || info.Body["kind"] != "email" || info.Body["inviterName"] != "emowner" {
		t.Fatalf("email info: %d %s", info.Status, info.Raw)
	}
	if info.Body["memberCount"] != float64(2) { // owner + the seeded member
		t.Fatalf("info memberCount: %v", info.Body["memberCount"])
	}

	// The account holding the invited address (case-insensitive) accepts and
	// lands with the invited role.
	_, memberAccountToken, _ := env.FullAccount("Outsider+Member@example.com", "outsidermember")
	accepted := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": rawToken}, testkit.Bearer(memberAccountToken))
	if accepted.Status != http.StatusOK || accepted.Body["serverId"] != workspaceID {
		t.Fatalf("accept invite: %d %s", accepted.Status, accepted.Raw)
	}
	var role string
	if err := env.App.DB.QueryRow(`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE email = 'outsider+member@example.com')`, workspaceID).Scan(&role); err != nil || role != "member" {
		t.Fatalf("accepted role: %q err=%v", role, err)
	}

	// Single use with the TS precedence: the used invite answers "already
	// been used" even for the matching account (email invites are strictly
	// single-use — unlike join links, whose re-accept is conditionally
	// idempotent).
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": rawToken}, testkit.Bearer(memberAccountToken)); res.Status != http.StatusBadRequest || res.Body["error"] != "This invite has already been used" {
		t.Fatalf("reuse: %d %v", res.Status, res.Body)
	}
	var status string
	if err := env.App.DB.QueryRow(`SELECT status FROM workspace_invites WHERE id = ?`, created.Body["id"]).Scan(&status); err != nil || status != "accepted" {
		t.Fatalf("invite status after accept: %q err=%v", status, err)
	}

	// Pending list after accept: the member invite drained, the refused
	// legacy guest row stays pending until revoked.
	afterAccept := env.Serve("GET", "/api/servers/"+workspaceID+"/invites", nil, testkit.Scoped(ownerToken, workspaceID))
	if rows := decodeBareArray(t, afterAccept.Raw); len(rows) != 1 || rows[0]["invitedEmail"] != "legacy-guest@example.com" {
		t.Fatalf("pending list after accept: %s", afterAccept.Raw)
	}

	// An expired pending invite stops previewing and is replaceable; a live
	// duplicate is the 409; revocation deletes the row and kills the token.
	expiring := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "fresh@example.com"}, testkit.Scoped(ownerToken, workspaceID))
	if expiring.Status != http.StatusOK {
		t.Fatalf("expiring create: %d %s", expiring.Status, expiring.Raw)
	}
	if _, err := env.App.DB.Exec(`UPDATE workspace_invites SET expires_at = ? WHERE id = ?`, time.Now().Add(-time.Minute).UnixMilli(), expiring.Body["id"]); err != nil {
		t.Fatal(err)
	}
	if res := env.Serve("GET", "/api/auth/invite-info?token="+inviteOutboxToken(t, env.Outbox, "fresh@example.com"), nil, nil); res.Status != http.StatusNotFound {
		t.Fatalf("expired preview: %d", res.Status)
	}
	refreshed := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "fresh@example.com"}, testkit.Scoped(ownerToken, workspaceID))
	if refreshed.Status != http.StatusOK {
		t.Fatalf("expired invite not replaceable: %d %s", refreshed.Status, refreshed.Raw)
	}
	dup := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "fresh@example.com"}, testkit.Scoped(ownerToken, workspaceID))
	if dup.Status != http.StatusConflict || dup.Body["error"] != "An invite has already been sent to this email" {
		t.Fatalf("duplicate invite: %d %v", dup.Status, dup.Body)
	}
	inviteID, _ := refreshed.Body["id"].(string)
	if res := env.Serve("DELETE", "/api/servers/"+workspaceID+"/invites/"+inviteID, nil, testkit.Scoped(ownerToken, workspaceID)); res.Status != http.StatusOK || res.Body["ok"] != true {
		t.Fatalf("revoke invite: %d %s", res.Status, res.Raw)
	}
	var count int
	// Remaining rows: the accepted member invite and the refused legacy
	// guest invite; the expired fresh row was replaced (replacement deletes
	// the stale row) and the refreshed row was revoked.
	if err := env.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_invites WHERE workspace_id = ?`, workspaceID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("revoked invite rows: %d err=%v", count, err)
	}
	// The revoked (deleted) token no longer resolves at all.
	if res := env.Serve("GET", "/api/auth/invite-info?token="+inviteOutboxToken(t, env.Outbox, "fresh@example.com"), nil, nil); res.Status != http.StatusNotFound {
		t.Fatalf("revoked preview: %d", res.Status)
	}

	// The joined member now sees the workspace in their own server list —
	// the exact read the web performs to route after accepting.
	list := env.Serve("GET", "/api/servers", nil, testkit.Bearer(memberAccountToken))
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
		t.Fatalf("joined workspace missing from joiner's list: %s", list.Raw)
	}
}

func TestInviteCrossWorkspaceIsolation(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, ownerA, _ := env.FullAccount("iso-a@example.com", "isoalpha")
	_, ownerB, _ := env.FullAccount("iso-b@example.com", "isobeta")
	_, joiner, _ := env.FullAccount("iso-joiner@example.com", "isojoined")
	wsA := env.CreateServer(t, ownerA, "Iso A", "iso-alpha-ws")
	wsB := env.CreateServer(t, ownerB, "Iso B", "iso-beta-ws")

	createdB := env.Serve("POST", "/api/servers/"+wsB+"/join-links", map[string]any{}, testkit.Scoped(ownerB, wsB))
	if createdB.Status != http.StatusOK {
		t.Fatalf("create in B: %d", createdB.Status)
	}
	tokenB, _ := createdB.Body["token"].(string)
	linkB, _ := createdB.Body["link"].(map[string]any)
	idB, _ := linkB["id"].(string)

	// A's owner cannot list B's links (scope membership check) and a revoke
	// naming B's link id against A's workspace neither revokes nor errors.
	if res := env.Serve("GET", "/api/servers/"+wsB+"/join-links", nil, testkit.Scoped(ownerA, wsB)); res.Status != http.StatusForbidden {
		t.Fatalf("cross list: %d", res.Status)
	}
	if res := env.Serve("DELETE", "/api/servers/"+wsA+"/join-links/"+idB, nil, testkit.Scoped(ownerA, wsA)); res.Status != http.StatusOK {
		t.Fatalf("cross revoke shape: %d %s", res.Status, res.Raw)
	}
	if res := env.Serve("GET", "/api/auth/invite-info?token="+tokenB, nil, nil); res.Status != http.StatusOK || res.Body["serverName"] != "Iso B" {
		t.Fatalf("B's link must survive A's revoke attempt: %d %s", res.Status, res.Raw)
	}
	// Tokens are global capabilities, but they join exactly their own
	// workspace — never a bystander's.
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": tokenB}, testkit.Bearer(joiner)); res.Status != http.StatusOK || res.Body["serverId"] != wsB {
		t.Fatalf("join via B token: %d %s", res.Status, res.Raw)
	}
	var inA int
	if err := env.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE email = 'iso-joiner@example.com')`, wsA).Scan(&inA); err != nil || inA != 0 {
		t.Fatalf("joiner leaked into A: %d err=%v", inA, err)
	}
}

func TestInviteAcceptGatesAndMissingInputs(t *testing.T) {
	env := testkit.NewTestEnv(t)
	// accept-invite requires identity (the auth gate outranks body
	// validation, exactly like the TS requireAuth chain); invite-info is
	// public but still demands its token parameter.
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": "x"}, nil); res.Status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated accept: %d", res.Status)
	}
	_, done, _ := env.FullAccount("gate-done@example.com", "gatedone")
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{}, testkit.Bearer(done)); res.Status != http.StatusBadRequest || res.Body["error"] != "Invite token is required" {
		t.Fatalf("missing token: %d %v", res.Status, res.Body)
	}
	if res := env.Serve("GET", "/api/auth/invite-info", nil, nil); res.Status != http.StatusBadRequest || res.Body["error"] != "Token is required" {
		t.Fatalf("missing info token: %d %v", res.Status, res.Body)
	}
	if res := env.Serve("POST", "/api/auth/accept-invite", map[string]any{"token": "nonsense-token"}, testkit.Bearer(done)); res.Status != http.StatusBadRequest || res.Body["error"] != "Invalid invite token" {
		t.Fatalf("invalid token: %d %v", res.Status, res.Body)
	}
	if res := env.Serve("GET", "/api/auth/invite-info?token=nonsense-token", nil, nil); res.Status != http.StatusNotFound {
		t.Fatalf("invalid info token: %d", res.Status)
	}
	// Method policy: the new surfaces answer 405 only after the gates, and
	// the scope check still outranks the method answer.
	if res := env.Serve("PUT", "/api/servers/x/join-links", nil, nil); res.Status != http.StatusUnauthorized {
		t.Fatalf("405 gate order: %d", res.Status)
	}
	ws := env.CreateServer(t, done, "Method Order", "method-order-ws")
	mismatch := env.Serve("PUT", "/api/servers/"+ws+"/join-links", nil, testkit.Scoped(done, "00000000-0000-0000-0000-000000000000"))
	if mismatch.Status != http.StatusBadRequest || mismatch.Body["error"] != "X-Server-Id must match server id in URL" {
		t.Fatalf("scope mismatch precedence: %d %v", mismatch.Status, mismatch.Body)
	}
	method := env.Serve("PUT", "/api/servers/"+ws+"/join-links", nil, testkit.Scoped(done, ws))
	if method.Status != http.StatusMethodNotAllowed {
		t.Fatalf("unsupported method: %d %v", method.Status, method.Body)
	}
	nested := env.Serve("GET", "/api/servers/"+ws+"/join-links/some-link-id", nil, testkit.Scoped(done, ws))
	if nested.Status != http.StatusMethodNotAllowed {
		t.Fatalf("nested unsupported method: %d %v", nested.Status, nested.Body)
	}
}
